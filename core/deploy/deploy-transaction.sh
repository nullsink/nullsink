#!/usr/bin/env bash
# Small, sourceable deploy state machine. deploy.sh supplies the concrete callbacks below; keeping the
# sequencing here lets the test suite fault-inject every boundary without root, systemd, Caddy, or a live box.
#
# Staging callbacks (no live mutation):
#   deploy_stage_manifest, deploy_stage_ui, deploy_stage_binaries, deploy_stage_nsk, deploy_stage_tree
# Activation callbacks (rollback is armed before the first one):
#   deploy_prepare_guard, deploy_quiesce, deploy_activate_binaries, deploy_activate_nsk, deploy_activate_tree,
#   deploy_apply_config, deploy_activate_ui, deploy_commit_backend, deploy_restart_new, deploy_health_new,
#   deploy_enable_timers, deploy_record_success
# Failure callback:
#   deploy_rollback <failed-step>

run_deploy_staging() {
  deploy_stage_manifest || return 1
  deploy_stage_ui || return 1
  deploy_stage_binaries || return 1
  deploy_stage_nsk || return 1
  deploy_stage_tree || return 1
}

run_deploy_activation() {
  local step
  for step in \
    prepare_guard \
    quiesce \
    activate_binaries \
    activate_nsk \
    activate_tree \
    apply_config \
    activate_ui \
    commit_backend \
    restart_new \
    health_new \
    enable_timers \
    record_success
  do
    if ! "deploy_$step"; then
      deploy_rollback "$step" || true
      # The forward deploy failed even when the previous release was restored successfully. INT/TERM are
      # ignored only while rollback is active, so they cannot kill a child halfway through recovery.
      return 1
    fi
  done
}

# Rollback is the one interval where INT/TERM must not interrupt either Bash OR its foreground cp/mv/systemctl
# children. An ignored disposition is inherited by children; a shell trap that merely records a signal is not,
# so a terminal process-group Ctrl-C could otherwise kill a child halfway through restoration.
begin_deploy_rollback() {
  trap '' INT TERM
}

finish_deploy_rollback() {  # $1=0 when restored, 1 when incomplete
  local rollback_status="$1"
  trap 'exit 130' INT
  trap 'exit 143' TERM
  return "$rollback_status"
}
