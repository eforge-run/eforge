#!/usr/bin/env bash
# Single scenario runner — sourced by run.sh
# Usage: run_scenario <id> <fixture> <prd> <validate> <scenario_dir> <eforge_bin> <eforge_version> <eforge_commit>
#   validate is a ||| delimited list of commands

run_scenario() {
  local id="$1"
  local fixture="$2"
  local prd="$3"
  local validate="$4"
  local scenario_dir="$5"
  local eforge_bin="$6"
  local eforge_version="$7"
  local eforge_commit="$8"

  local fixture_dir="$FIXTURES_DIR/$fixture"

  local start_time
  start_time=$(date +%s)

  # Step 1: Verify fixture exists
  if [[ ! -d "$fixture_dir" ]]; then
    echo "  ERROR: Fixture not found: $fixture_dir"
    write_error_result "$scenario_dir" "$id" "$eforge_version" "$eforge_commit" "$start_time" \
      "Fixture directory not found: $fixture"
    return 1
  fi

  # Step 2: Copy fixture to workspace and init git
  # Create workspace in a temp directory OUTSIDE the eforge repo so pnpm doesn't
  # resolve to eforge's pnpm-workspace.yaml when installing fixture dependencies.
  local workspace
  workspace="$(mktemp -d -t "eforge-eval-${id}-XXXXXX")"
  echo "  Copying fixture '$fixture' to workspace..."
  cp -r "$fixture_dir/." "$workspace/"
  # Record workspace path for debugging
  echo "$workspace" > "$scenario_dir/workspace-path.txt"

  echo "  Initializing git repo..."
  (
    cd "$workspace"
    git init --quiet
    git add -A
    git commit --quiet -m "Initial commit (eval fixture)"
    # Create eval branch so eforge commits don't land on main
    git checkout --quiet -b "eval/$id"
  )

  # Step 3: Run eforge (or skip in dry-run mode)
  local eforge_exit=0
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Skipping eforge run (workspace ready at $workspace)"
    echo "[dry-run] eforge skipped" > "$scenario_dir/eforge.log"
  else
    # Tag Langfuse traces with eval metadata for filtering
    export EFORGE_TRACE_TAGS="eval,$id,$eforge_commit"

    # Output goes to both terminal (for live monitoring URL) and log file
    # Env vars (e.g. LANGFUSE_*) are inherited from run.sh's --env-file sourcing
    echo "  Running eforge run $prd --auto --verbose..."
    set +e
    (
      cd "$workspace"
      "$eforge_bin" run "$prd" --auto --verbose
    ) 2>&1 | tee "$scenario_dir/eforge.log"
    eforge_exit=${PIPESTATUS[0]}
    set -e
  fi

  if [[ $eforge_exit -eq 0 ]]; then
    echo "  Eforge completed successfully."
  else
    echo "  Eforge FAILED (exit code: $eforge_exit)"
  fi

  # Step 4: Run validation commands (only if eforge succeeded; skip in dry-run)
  local validation_results="{}"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [dry-run] Skipping validation"
  elif [[ $eforge_exit -eq 0 && -n "$validate" ]]; then
    echo "  Running validation..."
    validation_results=$(run_validations "$workspace" "$validate" "$scenario_dir")
  fi

  # Step 4b: Preserve monitor DB before workspace cleanup
  if [[ -f "$workspace/.eforge/monitor.db" ]]; then
    cp "$workspace/.eforge/monitor.db" "$scenario_dir/monitor.db"
  fi

  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))

  # Step 5: Write result.json
  npx tsx "$SCRIPT_DIR/lib/build-result.ts" \
    "$scenario_dir/result.json" \
    "$id" \
    "$eforge_version" \
    "$eforge_commit" \
    "$eforge_exit" \
    "$duration" \
    "$scenario_dir/eforge.log" \
    "$validation_results" \
    "$scenario_dir/monitor.db"

  echo "  Result: $scenario_dir/result.json"
  echo "  Duration: $((duration / 60))m $((duration % 60))s"

  # Clean up temp workspace (logs and results are already in scenario_dir)
  if [[ -d "$workspace" && "$workspace" == /tmp/* ]]; then
    rm -rf "$workspace"
  fi
  return 0
}

# Run validation commands and return JSON object via stdout.
# Progress messages go to stderr so they don't pollute the captured output.
run_validations() {
  local workspace="$1"
  local validate="$2"
  local scenario_dir="$3"

  local results="{"
  local first=true

  local -a cmds=()
  while [[ -n "$validate" ]]; do
    if [[ "$validate" == *'|||'* ]]; then
      cmds+=("${validate%%|||*}")
      validate="${validate#*|||}"
    else
      cmds+=("$validate")
      validate=""
    fi
  done

  local cmd_index=0
  for cmd in "${cmds[@]}"; do
    # Skip empty segments
    [[ -z "$cmd" ]] && continue
    cmd_index=$((cmd_index + 1))

    # Derive a short name from the command, prefixed with index to avoid collisions
    local name
    name="${cmd_index}-$(echo "$cmd" | awk '{print $NF}' | tr '/' '-')"

    echo "    Running: $cmd" >&2
    local exit_code=0
    (cd "$workspace" && eval "$cmd") > "$scenario_dir/validate-${name}.log" 2>&1 || exit_code=$?

    local passed="true"
    [[ $exit_code -ne 0 ]] && passed="false"

    if [[ "$first" == "true" ]]; then
      first=false
    else
      results+=","
    fi
    results+="\"$name\":{\"exitCode\":$exit_code,\"passed\":$passed}"

    if [[ $exit_code -ne 0 ]]; then
      echo "    FAILED: $cmd (exit code: $exit_code)" >&2
    else
      echo "    PASSED: $cmd" >&2
    fi
  done

  results+="}"
  echo "$results"
}

# Write an error result when the scenario fails before eforge runs
write_error_result() {
  local scenario_dir="$1"
  local id="$2"
  local eforge_version="$3"
  local eforge_commit="$4"
  local start_time="$5"
  local error_msg="$6"

  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - start_time))

  cat > "$scenario_dir/result.json" <<RESULT_EOF
{
  "scenario": "$id",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "eforgeVersion": "$eforge_version",
  "eforgeCommit": "$eforge_commit",
  "eforgeExitCode": 1,
  "validation": {},
  "durationSeconds": $duration,
  "error": "$error_msg"
}
RESULT_EOF
}
