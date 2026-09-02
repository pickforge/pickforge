use pickforge_cli::transaction::{apply_files, plan_file};
use tempfile::TempDir;

#[test]
fn concurrent_drift_aborts_before_any_write() {
    let temp = TempDir::new().unwrap();
    let first = temp.path().join("first.json");
    let second = temp.path().join("second.json");
    std::fs::write(&first, "old-one").unwrap();
    std::fs::write(&second, "old-two").unwrap();
    let (first_plan, _) = plan_file(first.clone(), b"new-one".to_vec(), true).unwrap();
    let (second_plan, _) = plan_file(second.clone(), b"new-two".to_vec(), true).unwrap();
    std::fs::write(&second, "drift").unwrap();
    let failure = apply_files(&[first_plan, second_plan], "stamp").unwrap_err();
    assert!(failure.rolled_back);
    assert_eq!(std::fs::read_to_string(first).unwrap(), "old-one");
    assert_eq!(std::fs::read_to_string(second).unwrap(), "drift");
    assert!(failure.backup_paths.is_empty());
}

#[test]
fn update_retains_exclusive_backup_and_uses_dash_two_on_collision() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("config.json");
    std::fs::write(&target, "old").unwrap();
    std::fs::write(
        temp.path().join("config.json.pickforge-backup-s"),
        "occupied",
    )
    .unwrap();
    let (plan, _) = plan_file(target.clone(), b"new".to_vec(), true).unwrap();
    let expected_backup = plan
        .path()
        .with_file_name("config.json.pickforge-backup-s-2");
    let backups = apply_files(&[plan], "s").unwrap();
    assert_eq!(backups, vec![expected_backup]);
    assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), "old");
    assert_eq!(std::fs::read_to_string(target).unwrap(), "new");
}

#[test]
fn no_op_creates_no_backup_or_temp_file() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("config.json");
    std::fs::write(&target, "same").unwrap();
    let (plan, _) = plan_file(target, b"same".to_vec(), true).unwrap();
    assert!(apply_files(&[plan], "s").unwrap().is_empty());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn unsafe_targets_fail_closed_and_modes_are_private_or_preserved() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    let temp = TempDir::new().unwrap();
    let real = temp.path().join("real");
    std::fs::write(&real, "x").unwrap();
    let link = temp.path().join("link");
    symlink(&real, &link).unwrap();
    assert!(plan_file(link, b"y".to_vec(), true).is_err());

    let hard = temp.path().join("hard");
    std::fs::hard_link(&real, &hard).unwrap();
    assert!(plan_file(real, b"y".to_vec(), true).is_err());
    assert!(plan_file(hard, b"y".to_vec(), true).is_err());

    let fifo = temp.path().join("directory");
    std::fs::create_dir(&fifo).unwrap();
    assert!(plan_file(fifo, b"y".to_vec(), true).is_err());

    let existing = temp.path().join("existing");
    std::fs::write(&existing, "old").unwrap();
    std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o640)).unwrap();
    let (update, _) = plan_file(existing.clone(), b"new".to_vec(), true).unwrap();
    apply_files(&[update], "s").unwrap();
    assert_eq!(std::fs::metadata(existing).unwrap().mode() & 0o777, 0o640);

    let created = temp.path().join("private").join("nested").join("new.json");
    let (create, _) = plan_file(created.clone(), b"new".to_vec(), true).unwrap();
    apply_files(&[create], "s").unwrap();
    assert_eq!(std::fs::metadata(&created).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::metadata(created.parent().unwrap()).unwrap().mode() & 0o777,
        0o700
    );
}

#[test]
fn invalid_backup_stamp_is_rejected_without_writing() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("config");
    std::fs::write(&target, "old").unwrap();
    let (plan, _) = plan_file(target.clone(), b"new".to_vec(), true).unwrap();
    assert!(apply_files(&[plan], "../escape").is_err());
    assert_eq!(std::fs::read_to_string(target).unwrap(), "old");
}

#[cfg(unix)]
#[test]
fn symlinked_parent_is_resolved_before_a_missing_target_is_planned() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let real = temp.path().join("real");
    std::fs::create_dir(&real).unwrap();
    let linked_parent = temp.path().join("linked-parent");
    symlink(&real, &linked_parent).unwrap();
    let (plan, _) = plan_file(linked_parent.join("config"), b"new".to_vec(), true).unwrap();
    apply_files(&[plan], "s").unwrap();
    assert_eq!(std::fs::read_to_string(real.join("config")).unwrap(), "new");
}

#[cfg(windows)]
#[test]
fn changed_readonly_target_is_refused_but_identical_content_is_a_noop() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("config");
    std::fs::write(&target, "same").unwrap();
    let mut permissions = std::fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&target, permissions).unwrap();
    assert!(plan_file(target.clone(), b"changed".to_vec(), true).is_err());
    let (noop, _) = plan_file(target.clone(), b"same".to_vec(), true).unwrap();
    assert!(apply_files(&[noop], "s").unwrap().is_empty());
    assert!(std::fs::metadata(target).unwrap().permissions().readonly());
}

#[test]
fn oversized_and_non_utf8_configs_are_refused() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("config");
    std::fs::write(&target, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(plan_file(target.clone(), vec![], true).is_err());
    std::fs::write(&target, [0xff]).unwrap();
    assert!(plan_file(target, vec![], true).is_err());
}
