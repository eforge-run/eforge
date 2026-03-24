#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
RESULTS_DIR="$SCRIPT_DIR/results"
SCENARIOS_FILE="$SCRIPT_DIR/scenarios.yaml"
MAX_RUNS=50  # Keep only the most recent N runs; older ones are pruned automatically

# Source the scenario runner
source "$SCRIPT_DIR/lib/run-scenario.sh"

# Parse scenarios.yaml into tab-separated fields using node
# Fields: id, fixture, prd, validate (||| delimited), description, expect (JSON)
parse_scenarios() {
  NODE_PATH="$REPO_ROOT/node_modules" node -e "
    const fs = require('fs');
    const yaml = require('yaml');
    const data = yaml.parse(fs.readFileSync('$SCENARIOS_FILE', 'utf8'));
    for (const s of data.scenarios) {
      const validate = (s.validate || []).join('|||');
      const expect = JSON.stringify(s.expect || {});
      console.log([s.id, s.fixture, s.prd, validate, s.description, expect].join('\t'));
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
  local runs=()
  # Timestamped dirs sort lexicographically (oldest first)
  while IFS= read -r dir; do
    runs+=("$dir")
  done < <(ls -1d "$RESULTS_DIR"/????-??-??T* 2>/dev/null | sort)
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
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$summary_file', 'utf8'));
    const pad = (str, len) => str.padEnd(len);
    console.log('Eforge Eval Results (' + s.timestamp + ')');
    console.log('eforge@' + s.eforgeVersion + ' (' + s.eforgeCommit + ')');
    console.log('');
    console.log(pad('Scenario', 35) + pad('Eforge', 10) + pad('Validate', 12) + pad('Expect', 10) + pad('Tokens', 10) + pad('Cache', 10) + pad('Cost', 10) + 'Duration');
    console.log('-'.repeat(110));
    for (const r of s.scenarios) {
      const eforge = r.eforgeExitCode === 0 ? 'PASS' : 'FAIL';
      const allValid = r.validation && Object.values(r.validation).every(v => v.passed);
      const validate = r.eforgeExitCode !== 0 ? '-' : (allValid ? 'PASS' : 'FAIL');
      const expect = !r.expectations ? '-' : (r.expectations.passed ? 'PASS' : 'FAIL');
      const tokens = r.metrics && r.metrics.tokens ? Math.round(r.metrics.tokens.total / 1000) + 'k' : '-';
      const cache = r.metrics && r.metrics.tokens && r.metrics.tokens.input > 0 && r.metrics.tokens.cacheRead
        ? Math.round(r.metrics.tokens.cacheRead / r.metrics.tokens.input * 100) + '%'
        : '-';
      const cost = r.metrics && r.metrics.costUsd != null ? '\$' + r.metrics.costUsd.toFixed(2) : '-';
      const mins = Math.floor(r.durationSeconds / 60);
      const secs = r.durationSeconds % 60;
      const duration = mins + 'm ' + secs + 's';
      console.log(pad(r.scenario, 35) + pad(eforge, 10) + pad(validate, 12) + pad(expect, 10) + pad(tokens, 10) + pad(cache, 10) + pad(cost, 10) + duration);
    }
    console.log('');
    console.log('Passed: ' + s.passed + '/' + s.totalScenarios);
    if (s.totals) {
      const t = s.totals;
      const totalTokens = t.tokens ? Math.round(t.tokens.total / 1000) + 'k' : '-';
      const totalCache = t.tokens && t.tokens.input > 0 && t.tokens.cacheRead
        ? Math.round(t.tokens.cacheRead / t.tokens.input * 100) + '%'
        : '-';
      const totalCost = t.costUsd != null ? '\$' + t.costUsd.toFixed(2) : '-';
      const totalMins = Math.floor(t.durationSeconds / 60);
      const totalSecs = t.durationSeconds % 60;
      console.log('Totals: ' + totalTokens + ' tokens, ' + totalCache + ' cached, ' + totalCost + ' cost, ' + totalMins + 'm ' + totalSecs + 's');
    }
    // Per-agent breakdown table
    const agentAgg = {};
    for (const r of s.scenarios) {
      if (!r.metrics || !r.metrics.agents) continue;
      for (const [role, a] of Object.entries(r.metrics.agents)) {
        if (!agentAgg[role]) {
          agentAgg[role] = { count: 0, tokens: 0, inputTokens: 0, cacheRead: 0, costUsd: 0, durationMs: 0 };
        }
        const agg = agentAgg[role];
        agg.count += a.count || 1;
        agg.tokens += a.totalTokens || 0;
        agg.inputTokens += a.inputTokens || 0;
        agg.cacheRead += a.cacheRead || 0;
        agg.costUsd += a.costUsd || 0;
        agg.durationMs += a.durationMs || 0;
      }
    }
    const agentRows = Object.entries(agentAgg).sort((a, b) => b[1].tokens - a[1].tokens);
    if (agentRows.length > 0) {
      console.log('');
      console.log('Per-Agent Breakdown:');
      console.log(pad('Agent', 25) + pad('Count', 8) + pad('Tokens', 12) + pad('Cache', 10) + pad('Cost', 10) + 'Duration');
      console.log('-'.repeat(80));
      for (const [agent, d] of agentRows) {
        const tokens = Math.round(d.tokens / 1000) + 'k';
        const cache = d.inputTokens > 0 && d.cacheRead > 0 ? Math.round(d.cacheRead / d.inputTokens * 100) + '%' : '-';
        const cost = '\$' + d.costUsd.toFixed(2);
        const mins = Math.floor(d.durationMs / 1000 / 60);
        const secs = Math.floor(d.durationMs / 1000) % 60;
        const duration = mins + 'm ' + secs + 's';
        console.log(pad(agent, 25) + pad(String(d.count), 8) + pad(tokens, 12) + pad(cache, 10) + pad(cost, 10) + duration);
      }
    }
  "
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
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

  # Start shared monitor server
  export EFORGE_MONITOR_DB="$run_dir/monitor.db"
  local server_main="$REPO_ROOT/dist/server-main.js"
  local server_runner="node"
  if [[ ! -f "$server_main" ]]; then
    server_main="$REPO_ROOT/src/monitor/server-main.ts"
    server_runner="npx tsx"
  fi
  local monitor_pid=""
  if [[ "$DRY_RUN" == "false" ]]; then
    $server_runner "$server_main" "$EFORGE_MONITOR_DB" 4580 "$REPO_ROOT" &
    monitor_pid=$!
    # Detach so the server survives shell exit — the ephemeral countdown
    # (10s without browser, 60s with) handles auto-shutdown
    disown $monitor_pid
  fi

  echo "Eforge Eval Run"
  echo "  Version: $eforge_version ($eforge_commit)"
  echo "  Results: $run_dir"
  if [[ -n "$monitor_pid" ]]; then
    echo "  Monitor: http://localhost:4580"
  fi
  echo ""

  # Parse scenarios and run
  local results=()
  local passed=0
  local total=0

  while IFS=$'\t' read -r id fixture prd validate description expect_json; do
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
    if run_scenario "$id" "$fixture" "$prd" "$validate" "$scenario_dir" "$eforge_bin" "$eforge_version" "$eforge_commit" "$expect_json"; then
      # Check if all validations passed
      local all_passed
      all_passed=$(node -e "
        const r = JSON.parse(require('fs').readFileSync('$result_file', 'utf8'));
        const eforgeOk = r.eforgeExitCode === 0;
        const validateOk = Object.values(r.validation || {}).every(v => v.passed);
        const expectOk = !r.expectations || r.expectations.passed;
        console.log(eforgeOk && validateOk && expectOk ? 'yes' : 'no');
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
    // Aggregate totals across all scenarios
    let totalInputTokens = 0, totalOutputTokens = 0, totalTokens = 0, totalCacheRead = 0, totalCostUsd = 0, totalDurationSeconds = 0;
    for (const r of scenarios) {
      totalDurationSeconds += r.durationSeconds || 0;
      if (r.metrics) {
        if (r.metrics.tokens) {
          totalInputTokens += r.metrics.tokens.input || 0;
          totalOutputTokens += r.metrics.tokens.output || 0;
          totalTokens += r.metrics.tokens.total || 0;
          totalCacheRead += r.metrics.tokens.cacheRead || 0;
        }
        totalCostUsd += r.metrics.costUsd || 0;
      }
    }
    const summary = {
      timestamp: '$timestamp',
      eforgeVersion: '$eforge_version',
      eforgeCommit: '$eforge_commit',
      totalScenarios: $total,
      passed: $passed,
      scenarios,
      totals: {
        tokens: { input: totalInputTokens, output: totalOutputTokens, total: totalTokens, cacheRead: totalCacheRead },
        costUsd: totalCostUsd,
        durationSeconds: totalDurationSeconds
      }
    };
    fs.writeFileSync('$summary_file', JSON.stringify(summary, null, 2));
  "

  print_summary "$summary_file"
}

main "$@"
