#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
RESULTS_DIR="$SCRIPT_DIR/results"
SCENARIOS_FILE="$SCRIPT_DIR/scenarios.yaml"
MAX_RUNS=5  # Keep only the most recent N runs; older ones are pruned automatically

# Source the scenario runner
source "$SCRIPT_DIR/lib/run-scenario.sh"

# Parse scenarios.yaml into tab-separated fields using node
# Fields: id, fixture, prd, validate (||| delimited), description
parse_scenarios() {
  NODE_PATH="$REPO_ROOT/node_modules" node -e "
    const fs = require('fs');
    const yaml = require('yaml');
    const data = yaml.parse(fs.readFileSync('$SCENARIOS_FILE', 'utf8'));
    for (const s of data.scenarios) {
      const validate = (s.validate || []).join('|||');
      console.log([s.id, s.fixture, s.prd, validate, s.description].join('\t'));
    }
  "
}

# Cleanup all eval results
cleanup() {
  echo "Cleaning up all eval results..."
  if [[ -d "$RESULTS_DIR" ]]; then
    rm -rf "$RESULTS_DIR"
    echo "Removed $RESULTS_DIR"
  else
    echo "Nothing to clean."
  fi
}

# Prune old runs, keeping only the most recent MAX_RUNS
prune_old_runs() {
  [[ -d "$RESULTS_DIR" ]] || return 0
  local runs
  # Timestamped dirs sort lexicographically (oldest first)
  mapfile -t runs < <(ls -1d "$RESULTS_DIR"/????-??-??T* 2>/dev/null | sort)
  local count=${#runs[@]}
  if (( count <= MAX_RUNS )); then
    return 0
  fi
  local to_remove=$(( count - MAX_RUNS ))
  echo "Pruning $to_remove old run(s) (keeping last $MAX_RUNS)..."
  for (( i=0; i<to_remove; i++ )); do
    echo "  Removing ${runs[$i]}"
    rm -rf "${runs[$i]}"
  done
}

# Print summary table
print_summary() {
  local summary_file="$1"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$summary_file', 'utf8'));
    const pad = (str, len) => str.padEnd(len);
    console.log('Eforge Eval Results (' + s.timestamp + ')');
    console.log('eforge@' + s.eforgeVersion + ' (' + s.eforgeCommit + ')');
    console.log('');
    console.log(pad('Scenario', 35) + pad('Eforge', 10) + pad('Validate', 12) + 'Duration');
    console.log('-'.repeat(70));
    for (const r of s.scenarios) {
      const eforge = r.eforgeExitCode === 0 ? 'PASS' : 'FAIL';
      const allValid = r.validation && Object.values(r.validation).every(v => v.passed);
      const validate = r.eforgeExitCode !== 0 ? '-' : (allValid ? 'PASS' : 'FAIL');
      const mins = Math.floor(r.durationSeconds / 60);
      const secs = r.durationSeconds % 60;
      const duration = mins + 'm ' + secs + 's';
      console.log(pad(r.scenario, 35) + pad(eforge, 10) + pad(validate, 12) + duration);
    }
    console.log('');
    console.log('Passed: ' + s.passed + '/' + s.totalScenarios);
  "
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Main
main() {
  local filter=""
  ENV_FILE=""      # exported for run-scenario.sh
  DRY_RUN=false    # exported for run-scenario.sh

  # Handle arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cleanup)    cleanup; exit 0 ;;
      --dry-run)    DRY_RUN=true; shift ;;
      --env-file)   ENV_FILE="$(realpath "$2")"; shift 2 ;;
      *)            filter="$1"; shift ;;
    esac
  done

  # Source env file if provided (e.g. Langfuse credentials)
  # Same as: LANGFUSE_PUBLIC_KEY=... eforge run ...
  if [[ -n "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
      echo "Error: env file not found: $ENV_FILE"
      exit 1
    fi
    set -a && source "$ENV_FILE" && set +a
  fi

  # Resolve eforge binary — use the repo's built version, not the global one,
  # so we're always testing the version in this checkout
  local eforge_bin="$REPO_ROOT/dist/cli.js"
  if [[ "$DRY_RUN" == "false" && ! -f "$eforge_bin" ]]; then
    echo "Error: eforge not built. Run 'pnpm build' first."
    exit 1
  fi

  # Create timestamped results directory
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H-%M-%S)"
  local run_dir="$RESULTS_DIR/$timestamp"
  mkdir -p "$run_dir"

  # Prune old runs before starting
  prune_old_runs

  # Get eforge version info
  local eforge_version eforge_commit
  eforge_version="$(node -e "console.log(require('$REPO_ROOT/package.json').version)")"
  eforge_commit="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"

  echo "Eforge Eval Run"
  echo "  Version: $eforge_version ($eforge_commit)"
  echo "  Results: $run_dir"
  echo ""

  # Parse scenarios and run
  local results=()
  local passed=0
  local total=0

  while IFS=$'\t' read -r id fixture prd validate description; do
    # Filter if specified
    if [[ -n "$filter" && "$id" != "$filter" ]]; then
      continue
    fi

    total=$((total + 1))
    echo "━━━ Scenario: $id ━━━"
    echo "  $description"
    echo "  Fixture: $fixture"
    echo "  PRD: $prd"
    echo ""

    local scenario_dir="$run_dir/$id"
    mkdir -p "$scenario_dir"

    # Run the scenario
    local result_file="$scenario_dir/result.json"
    if run_scenario "$id" "$fixture" "$prd" "$validate" "$scenario_dir" "$eforge_bin" "$eforge_version" "$eforge_commit"; then
      # Check if all validations passed
      local all_passed
      all_passed=$(node -e "
        const r = JSON.parse(require('fs').readFileSync('$result_file', 'utf8'));
        const ok = r.eforgeExitCode === 0 && Object.values(r.validation || {}).every(v => v.passed);
        console.log(ok ? 'yes' : 'no');
      ")
      if [[ "$all_passed" == "yes" ]]; then
        passed=$((passed + 1))
      fi
    fi

    echo ""
  done < <(parse_scenarios)

  if [[ $total -eq 0 ]]; then
    if [[ -n "$filter" ]]; then
      echo "Error: No scenario found with id '$filter'"
      exit 1
    else
      echo "Error: No scenarios defined in $SCENARIOS_FILE"
      exit 1
    fi
  fi

  # Write summary
  local summary_file="$run_dir/summary.json"
  node -e "
    const fs = require('fs');
    const path = require('path');
    const scenarios = [];
    const dirs = fs.readdirSync('$run_dir', { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const rf = path.join('$run_dir', d.name, 'result.json');
      if (fs.existsSync(rf)) scenarios.push(JSON.parse(fs.readFileSync(rf, 'utf8')));
    }
    const summary = {
      timestamp: '$timestamp',
      eforgeVersion: '$eforge_version',
      eforgeCommit: '$eforge_commit',
      totalScenarios: $total,
      passed: $passed,
      scenarios
    };
    fs.writeFileSync('$summary_file', JSON.stringify(summary, null, 2));
  "

  print_summary "$summary_file"
}

main "$@"
