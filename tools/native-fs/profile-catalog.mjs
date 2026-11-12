/** Source-reviewed native test populations. These prove named mechanisms, not whole-CLI acceptance. */
export const NODE_LIFECYCLE_CASES = Object.freeze([
  'existing-readonly-bigint-identity',
  'existing-replace-exact-bytes',
  'existing-append-exact-bytes',
  'new-parent-inheritance',
  'new-no-clobber',
  'existing-byte-change-refusal',
  'cancel-before-stage',
  'cancel-before-publish',
  'live-producer-recovery-retains',
  'cancelled-recovery-retains',
  'killed-node-producer-recovery',
]);
const MACOS = [
  'common::producer_tests::owned_existing_stage_publishes_reviewed_bytes_after_pin',
  'common::producer_tests::owned_new_stage_uses_actual_parent_inheritance_and_exclusive_publish',
  'common::producer_tests::private_access_and_new_file_policy_hold_under_child_umasks',
  ...[
    'macos_copyfile_preserves_fixture_deny_acl',
    'macos_explicit_acl_preparation_is_read_only_and_rechecks',
    'macos_new_file_template_matches_direct_parent_creation',
    'macos_no_acl_preparation_uses_volume_capability_evidence',
    'macos_parent_snapshot_detects_policy_only_change',
    'macos_private_stage_removes_inherited_acl_before_use',
    'macos_private_stage_requires_owner_only_mode_and_no_acl',
    'macos_publication_checks_stage_identity_and_new_target_exclusivity',
    'macos_quarantine_copy_and_explicit_reapply',
    'macos_refuses_immutable_append_and_unknown_flags_before_publication',
    'macos_refuses_unknown_attribute_namespace',
    'macos_refuses_attribute_count_above_profile_limit',
  ].map((name) => `macos_mechanism_tests::${name}`),
  ...[
    'binary_protocol_is_closed_and_full_identity_roundtrips',
    'cancelled_recovery_and_exclusive_claims_preserve_artifacts',
    'cancellation_after_reservation_creation_reclaims_exact_marker_before_return',
    'changed_home_authority_and_changed_marker_preserve_ownership_evidence',
    'inventory_capacity_never_evicts_or_allocates_untracked',
    'killed_native_producer_is_recovered_only_after_pinning',
    'live_producer_and_hardlinked_payload_preserve_evidence',
    'pin_is_empty_only_and_cleanup_is_exact',
    'recovery_never_creates_missing_index_state_or_trusts_malformed_ancestors',
    'pre_pin_cleanup_handles_owned_partial_and_renamed_marker_states',
    'pre_pin_cleanup_preserves_aliases_and_unknown_children',
    'repeated_normal_pre_pin_cancellation_does_not_consume_inventory',
  ].map((name) => `stage_index::tests::${name}`),
];
const LINUX = [
  'linux_owned_child_mask_and_default_acl_matrix',
  'linux_existing_acl_xattr_and_nodump_survive_changed_bytes',
  'linux_metadata_only_change_is_detected_and_source_stays_unchanged',
  'linux_actual_parent_inheritance_matches_direct_creation_and_rejects_parent_change',
  'linux_new_file_racer_is_never_clobbered',
  'linux_actual_nontruncating_access_denial_preserves_source',
  'linux_stage_alias_and_privilege_bits_refuse_without_publication',
].map((name) => `linux::tests::${name}`);
// Diagnostic measurement only; this case does not certify a publication primitive.
export const WINDOWS_RENAME_PROBE_CASE = 'aaa_windows_rename_parameter_probe';
const RENAME_DIMENSIONS = [
  ['legacy', 'ex'],
  ['minimal', 'nul', 'padded'],
  ['relative', 'absolute'],
  ['same', 'cross'],
  ['new', 'replace'],
];
const NT_RENAME_DIMENSIONS = [
  ['nt'],
  ['minimal', 'nul', 'padded'],
  ['relative'],
  ['same', 'cross'],
  ['new', 'replace'],
];
const NT_PEER_DIMENSIONS = [
  ['nt'],
  ['padded'],
  ['peer'],
  ['rw', 'thin'],
  ['same', 'cross'],
  ['new', 'replace'],
];
const cartesianVariants = (dimensions) =>
  dimensions.reduce(
    (prefixes, dimension) =>
      prefixes.flatMap((prefix) =>
        dimension.map((suffix) => (prefix === '' ? suffix : `${prefix}-${suffix}`)),
      ),
    [''],
  );
export const WINDOWS_RENAME_VARIANTS = Object.freeze([
  ...cartesianVariants(RENAME_DIMENSIONS),
  ...cartesianVariants(NT_RENAME_DIMENSIONS),
  ...cartesianVariants(NT_PEER_DIMENSIONS),
]);
export const WINDOWS_RENAME_STATUSES = Object.freeze([
  'ok',
  'invalid-parameter',
  'access-denied',
  'sharing-violation',
  'lock-violation',
  'source-missing',
  'destination-exists',
  'invalid-name',
  'not-supported',
  'not-same-device',
  'privilege-not-held',
  'other',
  'mutation',
  'pending',
]);
export const WINDOWS_SECURITY_PROBE_CASE = 'aaa_windows_security_descriptor_probe';
export const WINDOWS_SECURITY_VARIANTS = Object.freeze(
  cartesianVariants([
    ['protected', 'unprotected', 'inherited'],
    ['setinfo', 'nt-basic', 'nt-protection'],
  ]),
);
export const WINDOWS_SECURITY_STATUSES = Object.freeze([
  'exact',
  'owner-changed',
  'group-changed',
  'dacl-changed',
  'protected-changed',
  'auto-inherited-changed',
  'access-denied',
  'unsupported',
  'error',
]);
export const WINDOWS_OWNER_CASE =
  'windows::tests::windows_default_owner_payload_uses_effective_token_and_private_files_remain_user_owned';
const WINDOWS = [
  'windows_default_owner_payload_uses_effective_token_and_private_files_remain_user_owned',
  'windows_token_context_owner_pair_is_closed_and_binds_identity',
  'windows_recovery_ownership_accepts_final_dacl_and_refuses_links_or_directories',
  'windows_profile_preserves_dacl_owner_group_zone_and_exact_bytes',
  'windows_profile_denied_data_write_and_append_leave_source_unchanged',
  'windows_profile_refuses_unknown_and_oversized_named_streams',
  'windows_profile_rechecks_metadata_only_changes_and_parent_policy',
  'windows_profile_new_file_matches_direct_destination_inheritance',
  'windows_profile_no_clobber_and_replacement_failure_preserve_old_bytes',
].map((name) => `windows::tests::${name}`);
export function rustPopulation(platform) {
  const passed =
    platform === 'darwin'
      ? MACOS
      : platform === 'linux'
        ? LINUX
        : platform === 'win32'
          ? WINDOWS
          : undefined;
  if (passed === undefined) throw new Error('NATIVE_FS_PROFILE_PLATFORM');
  return {
    passed: [
      ...passed,
      'common::producer_crash_tests::native_producer_partial_crashes_recover',
      'test_hooks::first_failure_preserves_primary_and_evaluates_once',
      ...(platform === 'win32'
        ? [
            WINDOWS_RENAME_PROBE_CASE,
            WINDOWS_SECURITY_PROBE_CASE,
            'common::template_cleanup_tests::windows_changed_current_token_context_preserves_stage_until_restored',
          ]
        : []),
      ...[
        'diagnostic_unwrapped_source_error_precedes_cleanup_failure',
        'ordinary_template_failures_cleanup_before_next_operation',
        'template_guard_preserves_hardlinked_and_replaced_objects',
        'uncertain_template_cleanup_retains_reservation_and_alias',
        'private_creation_opened_handle_failures_leave_no_owned_artifacts',
        'private_directory_unopened_identity_preserves_reservation',
      ].map((name) => `common::template_cleanup_tests::${name}`),
    ].sort(),
    ignored: [
      'common::producer_crash_tests::crash_child',
      ...(platform === 'darwin'
        ? ['common::producer_tests::private_umask_child', 'stage_index::tests::crash_child']
        : platform === 'linux'
          ? ['linux::tests::linux_umask_child']
          : []),
    ].sort(),
  };
}
