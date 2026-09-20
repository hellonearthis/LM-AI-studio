import os
import sys
import json
import sqlite3
import time
import argparse
from collections import Counter

# Automatically handle Laya import
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')
try:
    import laya
except ImportError:
    # If running outside the Laya .venv, attempt to find Laya virtual environment
    laya_venv_python = r"C:\Users\Desktop-Dev\Desktop\Laya\.venv\Scripts\python.exe"
    print(f"[!] 'laya' package not found in current Python environment.")
    print(f"[*] Please run this script with Laya's virtualenv:")
    print(f"    & \"{laya_venv_python}\" \"{__file__}\"")
    sys.exit(1)

# Curated visual taxonomy covering typical visual library domains
VISUAL_TAXONOMY = {
    "sculpture_installation": "abstract sculpture, 3D art installation, carved wood/stone, gallery exhibit pieces",
    "portrait_character": "human portrait, faces, character close-up, emotional expression, human figures",
    "architecture_monument": "exterior buildings, skyscrapers, historical monuments, bridges, stone structures",
    "interior_spaces": "interior rooms, architectural interiors, furniture, indoor staging, decor",
    "nature_landscape": "natural scenic landscapes, mountains, forests, oceans, valleys, outdoor vistas",
    "wildlife_fauna": "wild animals, birds, marine life, insects, fauna in nature",
    "botanical_flora": "plants, flowers, leaves, foliage, botanical close-ups, garden flora",
    "urban_street": "city streets, urban life, pedestrians, traffic, storefronts, evening cityscapes",
    "vehicle_machinery": "automobiles, aircraft, trains, heavy equipment, industrial machinery, engines",
    "macro_texture": "macro surface textures, materials, abstract close-up patterns, geometric surfaces",
    "fantasy_scifi": "futuristic technology, cyberpunk, sci-fi concepts, fantasy creatures, surreal digital art"
}

def enrich_clusters(db_path, samples_per_cluster=5, rescue_noise=False, max_noise_samples=200):
    if not os.path.exists(db_path):
        print(f"[!] Database file not found at: {db_path}")
        return

    print(f"[*] Connecting to database: {db_path}")
    con = sqlite3.connect(db_path)
    cur = con.cursor()

    # Verify tables exist
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('image_clusters', 'images')")
    tables = [r[0] for r in cur.fetchall()]
    if 'image_clusters' not in tables or 'images' not in tables:
        print("[!] Required tables ('image_clusters' and 'images') not found in database.")
        con.close()
        return

    print("[*] Loading Laya Decision Engine (convaiinnovations/laya)...")
    start_load = time.time()
    agent = laya.load("convaiinnovations/laya")
    print(f"[*] Laya model loaded in {time.time() - start_load:.2f}s")

    questions = {
        "theme": {
            "type": "choice",
            "instructions": "What visual subject category best describes this image?",
            "criteria": VISUAL_TAXONOMY
        }
    }

    # Fetch unique clusters (excluding -1 noise)
    cur.execute("""
        SELECT cluster_label, COUNT(*) as cnt 
        FROM image_clusters 
        WHERE cluster_label != -1 
        GROUP BY cluster_label 
        ORDER BY cluster_label ASC
    """)
    cluster_stats = cur.fetchall()
    print(f"[*] Found {len(cluster_stats)} distinct EVoC clusters to enrich.")

    # Create cluster_themes table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cluster_themes (
            cluster_label INTEGER PRIMARY KEY,
            theme_name TEXT,
            confidence REAL,
            purity REAL,
            item_count INTEGER,
            sample_summary TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    theme_results = []
    print("\n" + "=" * 75)
    print(f"{'Cluster':<9} | {'Item Count':<11} | {'Primary Theme':<24} | {'Purity':<8} | {'Conf'}")
    print("=" * 75)

    cluster_to_theme = {}

    for cid, count in cluster_stats:
        cur.execute("""
            SELECT i.id, i.analysis 
            FROM image_clusters c
            JOIN images i ON c.image_id = i.id
            WHERE c.cluster_label = ? AND i.analysis IS NOT NULL AND i.analysis != ''
            LIMIT ?
        """, (cid, samples_per_cluster))
        rows = cur.fetchall()

        if not rows:
            continue

        sample_votes = []
        confidences = []
        sample_snippets = []

        for img_id, analysis_raw in rows:
            try:
                parsed = json.loads(analysis_raw)
                summary = parsed.get("summary", "")
            except Exception:
                summary = analysis_raw[:250]

            if not summary.strip():
                continue

            # Evaluate with Laya (truncate to ~300 chars to fit ModernBERT context comfortably)
            res = agent.predict(summary[:320], questions)
            ans = res["answers"]["theme"]
            sample_votes.append(ans["choice"])
            confidences.append(ans["confidence"])
            if len(sample_snippets) < 2:
                sample_snippets.append(summary[:120].strip())

        if not sample_votes:
            continue

        # Tally votes to get consensus theme
        counts = Counter(sample_votes)
        top_theme, top_votes = counts.most_common(1)[0]
        purity = (top_votes / len(sample_votes)) * 100.0
        avg_conf = sum(confidences) / len(confidences)
        combined_snippets = " | ".join(sample_snippets)

        cluster_to_theme[cid] = top_theme
        theme_results.append((cid, top_theme, float(avg_conf), float(purity), count, combined_snippets))

        print(f"{cid:<9} | {count:<11} | {top_theme:<24} | {purity:>5.1f}%  | {avg_conf:>5.1%}")

    # Commit themes to database
    cur.executemany("""
        INSERT OR REPLACE INTO cluster_themes 
        (cluster_label, theme_name, confidence, purity, item_count, sample_summary)
        VALUES (?, ?, ?, ?, ?, ?)
    """, theme_results)
    con.commit()
    print("=" * 75)
    print(f"[+] Successfully categorized and saved {len(theme_results)} cluster themes into 'cluster_themes'.")

    # Optional: Triage unclustered -1 noise items
    if rescue_noise:
        cur.execute("""
            SELECT c.image_id, i.analysis 
            FROM image_clusters c
            JOIN images i ON c.image_id = i.id
            WHERE c.cluster_label = -1 AND i.analysis IS NOT NULL AND i.analysis != ''
            LIMIT ?
        """, (max_noise_samples,))
        noise_rows = cur.fetchall()
        print(f"\n[*] Evaluating {len(noise_rows)} unclustered (-1) noise samples for soft-theming...")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS image_cluster_suggestions (
                image_id INTEGER PRIMARY KEY,
                suggested_theme TEXT,
                confidence REAL,
                suggested_cluster INTEGER
            )
        """)

        # Invert theme to first matching cluster
        theme_to_first_cluster = {}
        for c_id, th, _, _, _, _ in theme_results:
            if th not in theme_to_first_cluster:
                theme_to_first_cluster[th] = c_id

        noise_suggestions = []
        rescued_count = 0

        for img_id, analysis_raw in noise_rows:
            try:
                parsed = json.loads(analysis_raw)
                summary = parsed.get("summary", "")
            except Exception:
                summary = analysis_raw[:250]

            if not summary.strip():
                continue

            res = agent.predict(summary[:320], questions)
            ans = res["answers"]["theme"]
            suggested_theme = ans["choice"]
            conf = ans["confidence"]

            # High confidence threshold for soft-rescue
            suggested_cid = theme_to_first_cluster.get(suggested_theme, -1)
            if conf >= 0.70 and suggested_cid != -1:
                rescued_count += 1

            noise_suggestions.append((img_id, suggested_theme, float(conf), suggested_cid if conf >= 0.70 else -1))

        cur.executemany("""
            INSERT OR REPLACE INTO image_cluster_suggestions 
            (image_id, suggested_theme, confidence, suggested_cluster)
            VALUES (?, ?, ?, ?)
        """, noise_suggestions)
        con.commit()
        print(f"[+] Processed {len(noise_suggestions)} noise items. {rescued_count} qualified for high-confidence thematic rescue (>= 70%).")

    con.close()
    print("\n[*] Enrichment complete!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Enrich EVoC clusters with Laya Decision Engine")
    parser.add_argument("--db", type=str, default=r"C:\Users\Desktop-Dev\Desktop\LM AI studio\images.db", help="Path to SQLite database")
    parser.add_argument("--samples", type=int, default=5, help="Number of samples to evaluate per cluster")
    parser.add_argument("--rescue-noise", action="store_true", help="Evaluate -1 noise items and suggest cluster themes")
    parser.add_argument("--max-noise", type=int, default=200, help="Max noise items to evaluate")
    args = parser.parse_args()

    enrich_clusters(
        db_path=args.db,
        samples_per_cluster=args.samples,
        rescue_noise=args.rescue_noise,
        max_noise_samples=args.max_noise
    )
