"""
Ovis Omni Embedding Service (FastAPI Microservice on Port 8082)

WHAT: A high-performance multimodal inference server serving the ATH-MaaS/Ovis-Omni-Embedding-3B model.
WHY: Unlike text-only embedding models, Ovis-Omni embeds both raw visual images and text queries directly into
     a unified 2048-dimensional vector space. Running this in a dedicated CUDA microservice on port 8082
     ensures Electron and the Node.js event loop remain completely responsive, while maximizing GPU throughput
     on modern NVIDIA hardware (e.g., RTX 5070 Ti).

TUTORIAL PROTOCOL & "CAN_BE_LONG" NAMING RULES:
- Variable names strictly prioritize semantic clarity over character count. Shorthand like 'i', 'tmp', 'img' is prohibited.
- Every function and logic branch is documented with WHAT and WHY commentary in a tutorial style.
"""

import os
import sys
import gc
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from PIL import Image, ImageFile
# WHAT: Allow loading images with non-standard, truncated, or slightly corrupt headers.
# WHY: Many internet memes, screenshots, and web downloads contain malformed iCCP color profiles 
#      or truncated data that cause PIL to throw UnidentifiedImageError unless LOAD_TRUNCATED_IMAGES is enabled.
ImageFile.LOAD_TRUNCATED_IMAGES = True
import torch
import torch.nn.functional as torch_functional
from fastapi import FastAPI, HTTPException, Body, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from transformers import (
    AutoProcessor,
    Qwen2_5OmniForConditionalGeneration,
    Qwen2_5OmniPreTrainedModel
)

# ============================================================================
# DATA CONTRACTS (PYDANTIC SCHEMAS)
# ============================================================================

class TextEmbeddingRequest(BaseModel):
    text_content: str = Field(..., description="The query or text phrase to vectorize.")
    instruction_prefix: Optional[str] = Field(
        default="Represent this query for retrieving relevant images: ",
        description="Task instruction prepended to guide the unified embedding representation."
    )

class ImageEmbeddingRequest(BaseModel):
    image_file_path: str = Field(..., description="Absolute physical path to the local image file on disk.")
    instruction_prefix: Optional[str] = Field(
        default="Represent this image for retrieval",
        description="Instruction guiding multimodal visual representation."
    )

class ZeroShotClassificationRequest(BaseModel):
    image_file_path: str = Field(..., description="Absolute physical path to the local image file on disk.")
    candidate_taxonomic_labels: List[str] = Field(..., description="List of category names to classify against.")
    classification_facet_name: Optional[str] = Field(default="visual_facet", description="Name of the facet category.")
    hypothesis_template: Optional[str] = Field(
        default="Represent this category for image classification: ",
        description="Instruction template prefixed to each candidate label."
    )

class BatchImageEmbeddingRequest(BaseModel):
    image_file_paths: List[str] = Field(..., description="List of physical image paths on disk to vectorize.")


# ============================================================================
# STATE ENGINE & MODEL LIFECYCLE
# ============================================================================

class OvisOmniRuntimeState:
    """
    WHAT: Holds singleton references to the neural network model, multimodal processor, and in-memory caches.
    WHY: Loading 3 Billion parameters into VRAM takes several seconds; keeping a single warm instance in memory
         enables rapid sub-30ms inference for zero-shot image classification and similarity searches.
    """
    def __init__(self):
        # WHAT: Resolve model weight location from local directory or Hugging Face cache.
        # WHY: Allows users to keep model files in their unified C:\llamaCPP\models folder
        #      while supporting completely offline startup without checking remote endpoints.
        custom_environment_path = os.environ.get("OVIS_MODEL_PATH")
        candidate_local_directories = [
            custom_environment_path,
            r"C:\llamaCPP\models\Ovis-Omni-Embedding-3B",
            r"C:\llamaCPP\models\ATH-MaaS\Ovis-Omni-Embedding-3B"
        ]

        verified_local_directory = None
        for candidate_directory_path in candidate_local_directories:
            if candidate_directory_path and os.path.isdir(candidate_directory_path):
                verified_local_directory = candidate_directory_path
                break

        if verified_local_directory:
            if os.path.exists(os.path.join(verified_local_directory, "model", "config.json")):
                self.model_identifier = verified_local_directory
                self.subfolder_path = "model"
            else:
                self.model_identifier = verified_local_directory
                self.subfolder_path = None
        else:
            self.model_identifier = "ATH-MaaS/Ovis-Omni-Embedding-3B"
            self.subfolder_path = "model"

        self.computation_device = "cuda" if torch.cuda.is_available() else "cpu"
        self.multimodal_model = None
        self.multimodal_processor = None
        self.is_model_fully_loaded = False
        self.cached_label_embeddings_map: Dict[str, torch.Tensor] = {}

    def initialize_neural_network(self):
        # WHAT: Initializing the neural network onto the selected hardware device.
        # WHY: We prefer bfloat16 precision when CUDA is available to halve memory consumption from ~12GB to ~6GB
        #      without degrading geometric similarity ranking fidelity.
        print(f"[OVIS-SERVICE] Preparing to load {self.model_identifier} on {self.computation_device}...")

        target_floating_point_precision = torch.bfloat16 if (self.computation_device == "cuda" and torch.cuda.is_bf16_supported()) else torch.float16
        if self.computation_device == "cpu":
            target_floating_point_precision = torch.float32

        try:
            # WHAT: Constructing common keyword arguments for model and processor loading.
            # WHY: Hugging Face transformers throws a TypeError if 'subfolder=None' is passed as an explicit
            #      keyword argument when loading directly from a flat local model folder on disk.
            shared_loading_arguments = {
                "trust_remote_code": True
            }
            if self.subfolder_path:
                shared_loading_arguments["subfolder"] = self.subfolder_path

            print("[OVIS-SERVICE] Loading multimodal processor with native chat template...")
            # WHAT: Attempting to load processor directly from local disk first.
            # WHY: Avoids redundant network checks to Hugging Face when files are already cached locally.
            try:
                self.multimodal_processor = AutoProcessor.from_pretrained(
                    self.model_identifier,
                    local_files_only=True,
                    **shared_loading_arguments
                )
            except Exception:
                self.multimodal_processor = AutoProcessor.from_pretrained(
                    self.model_identifier,
                    **shared_loading_arguments
                )

            print("[OVIS-SERVICE] Loading model weights into hardware memory...")
            # WHAT: Loading model weights while bypassing the speech talker dictionary requirement.
            # WHY: Ovis-Omni-Embedding-3B is purely an omni-modal embedding model derived from Qwen2.5-Omni.
            #      The generative speech talker components are pruned and 'spk_dict.pt' does not exist
            #      in the repository. Calling Qwen2_5OmniPreTrainedModel.from_pretrained.__func__ instantiates
            #      the full Qwen2_5OmniForConditionalGeneration class with all vision and thinker layers
            #      without triggering an OSError for the absent speech synthesis dictionary.
            try:
                self.multimodal_model = Qwen2_5OmniPreTrainedModel.from_pretrained.__func__(
                    Qwen2_5OmniForConditionalGeneration,
                    self.model_identifier,
                    local_files_only=True,
                    torch_dtype=target_floating_point_precision,
                    **shared_loading_arguments
                )
            except Exception:
                self.multimodal_model = Qwen2_5OmniPreTrainedModel.from_pretrained.__func__(
                    Qwen2_5OmniForConditionalGeneration,
                    self.model_identifier,
                    torch_dtype=target_floating_point_precision,
                    **shared_loading_arguments
                )
            if hasattr(self.multimodal_model, "disable_talker"):
                self.multimodal_model.disable_talker()
            self.multimodal_model.to(self.computation_device)
            self.multimodal_model.eval()

            self.is_model_fully_loaded = True
            print(f"[OVIS-SERVICE] Successfully initialized Ovis-Omni-Embedding-3B on {self.computation_device}!")
        except Exception as model_loading_exception:
            print(f"[OVIS-SERVICE-ERROR] Failed to load model weights: {model_loading_exception}")
            self.is_model_fully_loaded = False
            raise model_loading_exception

global_runtime_state = OvisOmniRuntimeState()


@asynccontextmanager
async def lifespan_event_handler(fastapi_application: FastAPI):
    # WHAT: Server startup lifecycle hook.
    # WHY: Pre-warms the model when the microservice launches so the very first incoming request doesn't stall.
    try:
        global_runtime_state.initialize_neural_network()
    except Exception as initialization_failure:
        print(f"[OVIS-SERVICE-WARNING] Deferred initialization due to startup error: {initialization_failure}")
    yield
    # WHAT: Server shutdown lifecycle hook.
    # WHY: Explicitly frees GPU VRAM allocations when the server process terminates.
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()


app = FastAPI(
    title="Lumina Ovis-Omni Multimodal Embedding Engine",
    description="Dedicated microservice for unified raw-image, text, and zero-shot visual classification embeddings.",
    version="1.0.0",
    lifespan=lifespan_event_handler
)

# Enable Cross-Origin Resource Sharing for Electron and local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# INFERENCE LOGIC (THE "HOW-TO" TUTORIAL ENGINE)
# ============================================================================

def extract_normalized_text_vector(raw_text_content: str, task_instruction_prefix: str) -> List[float]:
    """
    WHAT: Encodes a string of text into an L2-normalized 2048-dimensional embedding vector.
    WHY: According to the Ovis-Omni technical report, inputs must be formatted with a retrieval
         instruction via the chat template, passed through the thinker causal Transformer, and
         extracted from the final hidden state of the last non-padding token.
    """
    if not global_runtime_state.is_model_fully_loaded:
        raise HTTPException(status_code=503, detail="Ovis-Omni model is still loading or offline.")

    complete_instruction_payload = f"{task_instruction_prefix}{raw_text_content}".strip()
    formatted_chat_messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": complete_instruction_payload}
            ]
        }
    ]

    formatted_chat_string = global_runtime_state.multimodal_processor.apply_chat_template(
        formatted_chat_messages,
        tokenize=False,
        add_generation_prompt=True
    )

    tokenized_model_inputs = global_runtime_state.multimodal_processor(
        text=[formatted_chat_string],
        return_tensors="pt"
    )

    tokenized_model_inputs = {
        input_tensor_key: tensor_value.to(global_runtime_state.computation_device)
        for input_tensor_key, tensor_value in tokenized_model_inputs.items()
    }

    with torch.no_grad():
        inference_outputs = global_runtime_state.multimodal_model.thinker(**tokenized_model_inputs, output_hidden_states=True)

        # WHAT: Extracting the final hidden state from the thinker text model.
        # WHY: The thinker causally encodes multimodal token sequences. The final token position
        #      aggregates the unified semantic contextual representation.
        if hasattr(inference_outputs, "hidden_states") and inference_outputs.hidden_states:
            raw_last_layer_hidden_states = inference_outputs.hidden_states[-1]
        elif hasattr(inference_outputs, "last_hidden_state"):
            raw_last_layer_hidden_states = inference_outputs.last_hidden_state
        else:
            raise RuntimeError("Could not find hidden states in model inference output structure.")

        final_token_embedding = raw_last_layer_hidden_states[:, -1, :]
        normalized_embedding_tensor = torch_functional.normalize(final_token_embedding, p=2, dim=-1)

    return normalized_embedding_tensor[0].cpu().to(torch.float32).tolist()


def extract_normalized_image_vector(physical_image_file_path: str, task_instruction_prefix: str) -> List[float]:
    """
    WHAT: Encodes an image file on disk into an L2-normalized 2048-dimensional embedding vector.
    WHY: Eliminates the need to first transcribe the image into words with a generative captioning LLM.
         The visual encoder directly maps textures, colors, composition, and subjects into the unified vector space.
    """
    if not global_runtime_state.is_model_fully_loaded:
        raise HTTPException(status_code=503, detail="Ovis-Omni model is still loading or offline.")

    if not os.path.exists(physical_image_file_path):
        raise HTTPException(status_code=404, detail=f"Image file not found on disk at: {physical_image_file_path}")

    try:
        # WHAT: Resilient multi-tier image opening with PIL and OpenCV fallback.
        # WHY: Internet memes and web screenshots often have corrupted or non-standard PNG chunks 
        #      (such as bad iCCP CRC checksums). If PIL fails, OpenCV decodes the pixel array without choking on metadata.
        loaded_pil_image = None
        try:
            raw_pil_image = Image.open(physical_image_file_path)
            raw_pil_image.load()
            loaded_pil_image = raw_pil_image.convert("RGB")
        except Exception:
            try:
                import cv2
                decoded_bgr_frame = cv2.imread(physical_image_file_path)
                if decoded_bgr_frame is not None:
                    decoded_rgb_frame = cv2.cvtColor(decoded_bgr_frame, cv2.COLOR_BGR2RGB)
                    loaded_pil_image = Image.fromarray(decoded_rgb_frame)
            except Exception:
                pass

        if loaded_pil_image is None:
            raise ValueError(f"Could not decode image file using either PIL or OpenCV: {physical_image_file_path}")

        # WHAT: Cap ultra-high-resolution images to a maximum dimension of 1024px.
        # WHY: 4K, 8K, or panoramic images cause the vision patch encoder to generate massive token grids,
        #      stalling forward passes or exceeding GPU attention cache limits.
        maximum_dimension_threshold = 1024
        if max(loaded_pil_image.size) > maximum_dimension_threshold:
            loaded_pil_image.thumbnail((maximum_dimension_threshold, maximum_dimension_threshold), Image.Resampling.LANCZOS)
    except Exception as image_read_exception:
        raise HTTPException(status_code=400, detail=f"Failed to read image file: {image_read_exception}")

    formatted_chat_messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": loaded_pil_image},
                {"type": "text", "text": task_instruction_prefix}
            ]
        }
    ]

    formatted_chat_string = global_runtime_state.multimodal_processor.apply_chat_template(
        formatted_chat_messages,
        tokenize=False,
        add_generation_prompt=True
    )

    tokenized_model_inputs = global_runtime_state.multimodal_processor(
        text=[formatted_chat_string],
        images=[loaded_pil_image],
        return_tensors="pt"
    )

    tokenized_model_inputs = {
        input_tensor_key: tensor_value.to(global_runtime_state.computation_device)
        for input_tensor_key, tensor_value in tokenized_model_inputs.items()
    }

    with torch.no_grad():
        inference_outputs = global_runtime_state.multimodal_model.thinker(**tokenized_model_inputs, output_hidden_states=True)

        if hasattr(inference_outputs, "hidden_states") and inference_outputs.hidden_states:
            raw_last_layer_hidden_states = inference_outputs.hidden_states[-1]
        elif hasattr(inference_outputs, "last_hidden_state"):
            raw_last_layer_hidden_states = inference_outputs.last_hidden_state
        else:
            raise RuntimeError("Could not find hidden states in model inference output structure.")

        final_token_embedding = raw_last_layer_hidden_states[:, -1, :]
        normalized_embedding_tensor = torch_functional.normalize(final_token_embedding, p=2, dim=-1)

    return normalized_embedding_tensor[0].cpu().to(torch.float32).tolist()


# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.get("/")
def get_service_root_information():
    """
    WHAT: Returns an informational status dashboard and routing directory for the Ovis-Omni microservice.
    WHY: Prevents HTTP 404 Not Found errors when developers navigate directly to http://127.0.0.1:8082 in a web browser.
    """
    return {
        "service_name": "Lumina Ovis-Omni Multimodal Embedding Engine",
        "model_identifier": global_runtime_state.model_identifier,
        "is_model_fully_loaded": global_runtime_state.is_model_fully_loaded,
        "hardware_computation_device": global_runtime_state.computation_device,
        "interactive_api_documentation_url": "/docs",
        "health_check_endpoint_url": "/health",
        "supported_api_endpoints": [
            {"http_method": "GET", "endpoint_path": "/health", "endpoint_description": "Microservice readiness and GPU status"},
            {"http_method": "POST", "endpoint_path": "/embed/text", "endpoint_description": "Generate 2048-dimensional multimodal text query vector"},
            {"http_method": "POST", "endpoint_path": "/embed/image", "endpoint_description": "Generate 2048-dimensional multimodal raw image vector"},
            {"http_method": "POST", "endpoint_path": "/classify/zero-shot", "endpoint_description": "Zero-shot visual taxonomic classification"},
            {"http_method": "POST", "endpoint_path": "/embed/batch", "endpoint_description": "Batch sequential image vectorization"}
        ]
    }


@app.get("/favicon.ico", include_in_schema=False)
def get_favicon_placeholder():
    """
    WHAT: Returns an empty HTTP 204 No Content response for browser favicon requests.
    WHY: Prevents noisy HTTP 404 Not Found warnings in the server console when accessed via web browsers.
    """
    return Response(status_code=204)


@app.get("/health")
def get_service_health_status():
    """
    WHAT: Probes the health, GPU configuration, and model loading status of the microservice.
    WHY: Node.js and Electron poll this endpoint during app initialization to verify CUDA availability.
    """
    cuda_device_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "None (CPU Mode)"
    allocated_memory_megabytes = (torch.cuda.memory_allocated(0) / (1024 * 1024)) if torch.cuda.is_available() else 0.0

    return {
        "status": "online" if global_runtime_state.is_model_fully_loaded else "loading",
        "model_identifier": global_runtime_state.model_identifier,
        "device": global_runtime_state.computation_device,
        "cuda_available": torch.cuda.is_available(),
        "gpu_device_name": cuda_device_name,
        "allocated_vram_mb": round(allocated_memory_megabytes, 2),
        "embedding_dimensions": 2048
    }


@app.post("/embed/text")
def generate_text_embedding_vector(request_payload: TextEmbeddingRequest):
    """
    WHAT: Converts a text query into a 2048-dimensional multimodal embedding vector.
    WHY: Used by search.html to execute cross-modal text-to-image queries directly against image vectors.
    """
    generated_vector = extract_normalized_text_vector(
        raw_text_content=request_payload.text_content,
        task_instruction_prefix=request_payload.instruction_prefix
    )
    return {
        "embedding": generated_vector,
        "dimensions": len(generated_vector)
    }


@app.post("/embed/image")
def generate_image_embedding_vector(request_payload: ImageEmbeddingRequest):
    """
    WHAT: Converts a local image file into a 2048-dimensional multimodal embedding vector.
    WHY: Used by the batch maintenance pipeline to build ovis-embeddings.json and populate visual indexes.
    """
    generated_vector = extract_normalized_image_vector(
        physical_image_file_path=request_payload.image_file_path,
        task_instruction_prefix=request_payload.instruction_prefix
    )
    return {
        "embedding": generated_vector,
        "dimensions": len(generated_vector)
    }


@app.post("/classify/zero-shot")
def execute_zero_shot_visual_classification(request_payload: ZeroShotClassificationRequest):
    """
    WHAT: Classifies an image into arbitrary categories via zero-shot cosine similarity without training.
    WHY: Because images and text share the same vector space in Ovis-Omni, calculating the dot product between
         an image vector and candidate label vectors yields instant, mathematically grounded categorization.
    """
    # Step 1: Compute normalized visual vector for the target image
    image_vector_values = extract_normalized_image_vector(
        physical_image_file_path=request_payload.image_file_path,
        task_instruction_prefix="Represent this image for visual classification"
    )
    image_tensor = torch.tensor(image_vector_values, device=global_runtime_state.computation_device)

    # Step 2: Compute or retrieve cached embeddings for candidate labels
    candidate_scores_collection = []

    for candidate_label_text in request_payload.candidate_taxonomic_labels:
        cached_vector_tensor = global_runtime_state.cached_label_embeddings_map.get(candidate_label_text)

        if cached_vector_tensor is None:
            raw_label_vector = extract_normalized_text_vector(
                raw_text_content=candidate_label_text,
                task_instruction_prefix=request_payload.hypothesis_template
            )
            cached_vector_tensor = torch.tensor(raw_label_vector, device=global_runtime_state.computation_device)
            global_runtime_state.cached_label_embeddings_map[candidate_label_text] = cached_vector_tensor

        # WHAT: Cosine similarity via dot product.
        # WHY: Since both vectors are L2-normalized unit vectors, their dot product equals their cosine similarity.
        similarity_score_float = torch.dot(image_tensor, cached_vector_tensor).item()

        candidate_scores_collection.append({
            "label": candidate_label_text,
            "raw_similarity_score": round(similarity_score_float, 4)
        })

    # WHAT: Converting raw cosine similarities into normalized Softmax probability distribution.
    # WHY: Scaling with temperature (e.g., 20.0) transforms distance metrics into human-readable confidence percentages.
    raw_similarity_tensors = torch.tensor(
        [item["raw_similarity_score"] for item in candidate_scores_collection],
        device=global_runtime_state.computation_device
    )
    softmax_confidence_probabilities = torch_functional.softmax(raw_similarity_tensors * 20.0, dim=0).tolist()

    for item_index, confidence_value in enumerate(softmax_confidence_probabilities):
        candidate_scores_collection[item_index]["confidence"] = round(confidence_value, 4)

    # Sort descending by confidence
    candidate_scores_collection.sort(key=lambda score_entry: score_entry["confidence"], reverse=True)

    primary_top_label = candidate_scores_collection[0]["label"] if candidate_scores_collection else "unknown"
    primary_top_confidence = candidate_scores_collection[0]["confidence"] if candidate_scores_collection else 0.0

    return {
        "facet_name": request_payload.classification_facet_name,
        "top_label": primary_top_label,
        "top_confidence": primary_top_confidence,
        "predictions": candidate_scores_collection
    }


@app.post("/embed/batch")
def execute_batch_image_embedding(request_payload: BatchImageEmbeddingRequest):
    """
    WHAT: Ingests a list of image paths and generates their vectors sequentially with error resilience.
    WHY: Used by background maintenance jobs to index thousands of images without crashing on bad files.
    """
    batch_results_map = {}
    encountered_errors_map = {}

    for single_image_path in request_payload.image_file_paths:
        try:
            vector_result = extract_normalized_image_vector(
                physical_image_file_path=single_image_path,
                task_instruction_prefix="Represent this image for retrieval"
            )
            batch_results_map[single_image_path] = vector_result
        except Exception as single_image_error:
            encountered_errors_map[single_image_path] = str(single_image_error)

    return {
        "embeddings": batch_results_map,
        "successful_count": len(batch_results_map),
        "failed_count": len(encountered_errors_map),
        "errors": encountered_errors_map
    }
