---
name: coding-rules
description: Audit, refactor, and enforce the project's coding standards, specifically the "can_be_long" variable naming protocol and the "Tutorial Protocol" documentation style. Trigger when reviewing code, refactoring logic, checking variable names, or adding explanatory WHAT/WHY code comments.
---

# Coding Rules & Refactoring Skill

A workflow skill to enforce and validate the project's core coding standards across all files in the repository.

---

## The Two Core Protocols

### 1. Variable Naming Protocol (The "can_be_long" Rule)

- **Semantic Clarity Over Brevity:** Variable names must clearly reflect their exact logical function. Character count is never a constraint.
- **Strict Prohibition on Shorthand:** Never use abbreviations, acronyms, or single-letter identifiers (e.g., prohibited: `i`, `j`, `e`, `t`, `val`, `res`, `err`, `img`, `cb`, `req`, `tmp`).
- **Domain Context:** If a variable relates to a specific subsystem, data model, or domain (e.g., physics engine, New Zealand datasets, database records), include that specific domain in the name (e.g., `nz_economic_flow_rate`, `database_image_record_identifier`).
- **Descriptive Collections:** Use descriptive suffixes for compound data types (e.g., `_collection`, `_array`, `_set`, `_map`, `_dictionary`).

### 2. Documentation Style (The "Tutorial Protocol")

- **Instructional Tone:** Every function, branching condition, and major logic block must be documented as if it were a high-quality "How-to-Code" tutorial.
- **WHAT:** Describe precisely what the following block or expression accomplishes.
- **WHY:** Explain the engineering reasoning, algorithmic justification, or domain mechanics behind the logic.
- **Format:**
  ```javascript
  // WHAT: Calculating the density of the fluid at a specific grid point.
  // WHY: We use the pressure-to-mass ratio here to ensure the simulation
  // stays stable even when the velocity values spike.
  const fluid_density_at_current_coordinate = pressure / mass_constant;
  ```

---

## Workflow for Auditing and Refactoring

When activated, follow this systematic procedure:

### Step 1: Scan & Identify Violations
1. Search target files for single-letter variables (`\b[a-zA-Z]\b`), short loop indices, abbreviated parameters (`req`, `res`, `err`, `e`), and generic names (`data`, `temp`, `val`).
2. Identify functions and logic branches missing `// WHAT:` and `// WHY:` tutorial comments.

### Step 2: Plan the Refactor
1. Formulate clear, descriptive replacement names for all identified variables.
2. Draft tutorial-style explanations explaining *why* each branch, calculation, or guard condition exists.

### Step 3: Apply Code Changes
1. Use file replacement tools to apply updates without altering runtime semantics.
2. Ensure variable naming consistency across call sites, function signatures, and exported APIs.

### Step 4: Validate Syntax & Runtime Integrity
1. Run syntax verification (e.g. `node --check <file>` or linter).
2. Execute existing test suites or headless verification scripts to ensure no regressions were introduced.
