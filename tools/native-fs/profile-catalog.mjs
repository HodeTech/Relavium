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
  ...[
    'file_suffixes_refuse_while_parent_values_remain_strict_evidence',
    'exact_role_names_never_grant_cross_role_admission',
    'macl_parent_change_and_read_bounds_fail_closed',
    'file_macl_refuses_without_changing_source',
    'last_used_file_value_is_preserved_exactly_and_changes_refuse',
    'published_proof_checks_payload_length_identity_metadata_and_parent',
  ].map((name) => `macos::profile_tests::${name}`),
  ...[
    'empty_and_multibyte_publication_use_completed_payload_length',
    'payload_length_change_refuses_before_publication',
    'post_publication_failure_is_uncertain_without_rollback',
    'macl_prepublication_changes_preserve_target',
    'template_macl_refuses_before_payload_publication',
    'macl_postpublication_faults_are_possible_publication',
  ].map((name) => `common::macos_publication_tests::${name}`),
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
    'producer_claim_is_noninheritable_and_duplicate_does_not_relock',
    'v1_record_decodes_and_mismatched_versions_are_rejected',
    'completion_finishes_after_cancellation_and_reports_post_rmdir_faults',
    'reservation_cleanup_uncertainty_preserves_cancellation',
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
  'linux_admission_handoff_rechecks_bytes_and_policy',
  'linux_cleanup_failure_keeps_original_primary',
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
    ['setinfo', 'nt-basic', 'nt-protection', 'nt-request'],
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
  'windows_profile_refuses_readonly_sparse_compressed_and_linked_sources',
  'windows_profile_refuses_explicit_mandatory_label_without_changing_source',
  'windows_profile_rejects_invalid_components_and_reparse_handles',
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
  let passed;
  if (platform === 'darwin') passed = MACOS;
  else if (platform === 'linux') passed = LINUX;
  else if (platform === 'win32') passed = WINDOWS;
  let platformIgnored = [];
  if (platform === 'darwin')
    platformIgnored = [
      'common::producer_tests::private_umask_child',
      'common::macos_publication_tests::bounded_post_publication_proof_timing',
      'stage_index::tests::crash_child',
    ];
  else if (platform === 'linux')
    platformIgnored = [
      'linux::tests::linux_umask_child',
      'linux::tests::linux_effective_uid_acl_denies_real_uid_root',
      'common::linux_lower_admission_tests::linux_image_lower_crash_child',
      'common::linux_lower_admission_tests::linux_faccessat2_unavailable_child',
    ];
  if (passed === undefined) throw new Error('NATIVE_FS_PROFILE_PLATFORM');
  return {
    passed: [
      ...passed,
      ...(platform === 'linux'
        ? ['common::linux_lower_admission_tests::linux_image_lower_full_admission_and_failure_cuts']
        : []),
      'stage_index::custody_tests::claim_survives_duplicates_but_not_child_exec',
      'stage_index::custody_tests::native_producer_claim_noninheritance_and_independent_reader',
      // Concurrent processes on one operator home (ADR-0135): the allocation claim is waited for inside the
      // operation's deadline (all but one pool thread may wait, a caller beyond that gets a short grace,
      // cancellation comes first), only contention is retried, a claim on a replaced lock file is refused,
      // a producer's vanishing uncommitted entry is skipped by a scan but still counted toward the bound,
      // a pin removes only its own reservation, and `encode` enforces what `decode` requires.
      'stage_index::custody_tests::a_caller_beyond_the_limit_still_gets_through_a_busy_holder',
      'stage_index::custody_tests::a_cancelled_caller_beyond_the_limit_is_cancelled_not_changed',
      'stage_index::custody_tests::a_vanished_entry_is_counted_against_the_scan_bound',
      'stage_index::custody_tests::a_vanished_entry_still_counts_toward_the_bound_and_the_scan_has_slack',
      'stage_index::custody_tests::allocation_claim_wait_honours_cancellation',
      'stage_index::custody_tests::a_cancelled_recovery_behind_a_holder_is_cancelled',
      'stage_index::custody_tests::a_cleanup_beyond_the_limit_is_bounded_by_its_grace_not_the_deadline',
      'stage_index::custody_tests::a_cleanup_beyond_the_waiter_limit_gets_a_longer_grace_than_a_reservation',
      'stage_index::custody_tests::a_reservation_and_a_recovery_beyond_the_limit_get_only_the_short_grace',
      'stage_index::custody_tests::a_wait_that_used_up_the_budget_still_yields_a_usable_claim',
      'stage_index::custody_tests::allocation_claim_waits_for_a_holder_and_fails_closed_after_the_budget',
      'stage_index::custody_tests::only_contention_is_waited_out_as_a_claim_failure',
      'stage_index::custody_tests::pin_refuses_a_reservation_it_did_not_create',
      'stage_index::custody_tests::pin_removes_only_the_reservation_it_created',
      'stage_index::custody_tests::record_encode_enforces_the_decode_invariants',
      'stage_index::custody_tests::recovery_measures_its_pass_from_the_claim',
      'stage_index::custody_tests::recovery_waits_for_an_allocation_holder',
      'stage_index::custody_tests::reserve_measures_its_work_under_the_claim_from_the_claim',
      'stage_index::custody_tests::the_pool_size_is_read_the_way_libuv_reads_it',
      'stage_index::custody_tests::scan_skips_a_vanished_uncommitted_entry_but_not_a_committed_one',
      'stage_index::custody_tests::waiters_park_up_to_the_limit_and_the_next_one_gets_only_a_short_grace',
      // POSIX only, each for its own reason: a Windows scan can meet a delete-pending entry, replacing a lock
      // file that another handle holds open and removing files that are still held open by name are POSIX
      // idioms whose Windows behaviour is unverified, and a link count of zero is a POSIX notion; only the
      // eight-target CI could observe those.
      ...(platform === 'win32'
        ? []
        : [
            'stage_index::custody_tests::a_claim_error_that_is_not_contention_fails_at_once',
            'stage_index::custody_tests::a_claim_on_a_replaced_lock_file_is_refused',
            'stage_index::custody_tests::an_entry_unlinked_after_it_was_opened_still_counts_toward_the_bound',
            'stage_index::custody_tests::pre_pin_cleanup_measures_its_destructive_work_from_the_claim',
            'stage_index::custody_tests::post_publication_cleanup_measures_its_work_from_the_claim_and_gets_the_cleanup_grace',
            'stage_index::custody_tests::pre_pin_cleanup_gets_the_cleanup_grace',
            'stage_index::custody_tests::recovery_refuses_a_claim_on_a_replaced_lock_file',
            'stage_index::custody_tests::scan_skips_an_uncommitted_entry_unlinked_after_it_was_opened',
            'stage_index::custody_tests::scan_survives_concurrent_promotion_churn',
          ]),
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
        'write_failure_tokens_preserve_primary_and_cleanup',
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
      'stage_index::custody_tests::claim_exec_child',
      ...platformIgnored,
    ].sort(),
  };
}
