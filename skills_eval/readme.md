# skills_eval

An evaluation framework for AI Agent skills, designed to assess the quality of skills used by AI agents (e.g., Cursor Rules, Claude Code tools).

## Core Modules

| Module | Description |
|------|------|
| `core/` | Core utilities: concurrent runner, LLM invocation, filesystem operations, JSON parsing |
| `task_scheme/` | Evaluation scheme generation: takes `SKILL.md` as input and outputs test scenario definitions |
| `task_generate/` | Task generation: generates Harbor-executable tasks based on the scheme |
| `task_execute/` | Task execution: runs tasks via the Harbor framework |
| `task_judge/` | Result evaluation: assesses skill utility and safety using an LLM Judge |

## Workflow

```
SKILL.md -> Scheme Generation -> Task Generation -> Harbor Execution -> LLM Judge -> Summary Report
```

### 1. Generate Evaluation Scheme

**Utility test scheme:**
```bash
python -m task_scheme.utility_generate
```

**Security test scheme (with static scanning):**
```bash
python -m task_scheme.security_generate
```

### 2. Generate Tasks

```bash
python -m task_generate.utility_generate
```

### 3. Execute Tasks

```bash
# Single task execution
python -m task_execute.execute_single

# Batch execution
python -m task_execute.execute_batch
```

### 4. Judge Results

**Utility evaluation:**
```bash
python -m task_judge.run_utility_judge
```

**Security evaluation:**
```bash
python -m task_judge.run_security_judge
```

## Directory Structure

```
skills_eval/
├── config.py                    # Global configuration
├── core/
│   ├── runner.py                 # Concurrent runner (ThreadPoolExecutor + retries)
│   ├── llm_client.py             # Anthropic API / Claude CLI wrapper
│   ├── fs_utils.py               # Filesystem operations
│   ├── judge_collector.py        # Collect JudgeEntry
│   └── run_record_parser.py      # Parse run records
├── task_scheme/
│   ├── utility_generate.py       # Utility scheme generation
│   ├── security_generate.py      # Security scheme generation
│   ├── only_static_scanner.py    # Static scan only
│   └── only_security_generate.py # Generate security scheme only
├── task_generate/
│   └── utility_generate.py        # Generate Harbor Tasks
├── task_execute/
│   ├── execute_single.py        # Single task execution
│   └── execute_batch.py         # Batch execution
└── task_judge/
    ├── judge_logic.py             # Core Judge logic (utility + security)
    ├── run_utility_judge.py      # Utility judge entrypoint
    ├── run_security_judge.py     # Security judge entrypoint
    └── generate_skill_report.py  # Generate skill evaluation report
```

## Configuration

Configure settings in `config.py`:

```python
class BaseConfig:
    API_KEY      = os.environ.get("ANTHROPIC_API_KEY", "")
    API_BASE_URL = "https://api.anthropic.com"
    MODEL        = "claude-sonnet-4-6"
    MAX_TOKENS   = 16_000
    MAX_WORKERS  = 10
    MAX_RETRIES  = 3
```

**Input directory convention:**
```
<INPUT_DIR>/<category>/<owner>/<skill_name>/SKILL.md
```

## Output Structure

```
<OUTPUT_DIR>/<skill_name>/
├── utility_scheme.json      # Utility test scheme
├── security_scheme.json     # Security test scheme
├── tasks/                   # Generated Harbor Tasks
│   └── <task_id>/
│       ├── task.toml
│       ├── instruction.md
│       └── ...
└── judges/                  # Judge results
    └── <scenario_id>_judge.json
```
