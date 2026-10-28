use serde_json::{Value, json};
use std::process::Command;

fn data(script: &[u8]) -> Value {
    let script = std::str::from_utf8(script).unwrap();
    serde_json::from_str(
        script
            .split_once("const menuData = ")
            .unwrap()
            .1
            .strip_suffix(";\n")
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn stdout_contains_only_data_and_partial_runs_exit_nonzero() {
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("catalog.json");
    std::fs::write(
        &catalog,
        json!([
            {"name":"Unlinked", "url":null},
            {"name":"Bad URL", "url":"https://example.invalid/"}
        ])
        .to_string(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_food-finder"))
        .arg("--urls")
        .arg(&catalog)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let script = std::str::from_utf8(&output.stdout).unwrap();
    assert!(script.contains("const menuData = {\n  \"schemaVersion\":"));
    assert!(script.contains("\n  \"locations\": [\n    {\n"));
    let snapshot = data(&output.stdout);
    assert_eq!(snapshot["complete"], false);
    assert_eq!(snapshot["locations"][0]["status"], "no_ordering_url");
    assert_eq!(snapshot["locations"][1]["status"], "error");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("Invalid ordering URL"));
    assert!(stderr.contains("PARTIAL"));
    assert!(!stderr.contains("const menuData"));
}

#[test]
fn output_argument_replaces_the_named_file_and_leaves_stdout_empty() {
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("catalog.json");
    let path = directory.path().join("custom.js");
    std::fs::write(&path, "old content").unwrap();
    for name in ["Unlinked", "Changed without recompiling"] {
        std::fs::write(&catalog, json!([{"name": name, "url": null}]).to_string()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_food-finder"))
            .arg("--urls")
            .arg(&catalog)
            .arg("--output")
            .arg(&path)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        let snapshot = data(&std::fs::read(&path).unwrap());
        assert_eq!(snapshot["complete"], true);
        assert_eq!(snapshot["locations"][0]["name"], name);
    }
}

#[test]
fn output_failures_identify_the_destination_and_preserve_existing_files() {
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("catalog.json");
    let blocker = directory.path().join("not-a-directory");
    let destination = blocker.join("menus.js");
    std::fs::write(
        &catalog,
        json!([{"name":"Unlinked", "url":null}]).to_string(),
    )
    .unwrap();
    std::fs::write(&blocker, "keep this file").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_food-finder"))
        .arg("--urls")
        .arg(&catalog)
        .arg("--output")
        .arg(&destination)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains(&format!("Writing menu script to {}", destination.display())),
        "{stderr}"
    );
    assert!(stderr.contains("os error"), "{stderr}");
    assert_eq!(std::fs::read_to_string(&blocker).unwrap(), "keep this file");
}

#[test]
fn urls_argument_is_required_instead_of_using_an_embedded_catalog() {
    let output = Command::new(env!("CARGO_BIN_EXE_food-finder"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr).unwrap().contains("--urls"));
}

#[test]
fn unreadable_or_invalid_urls_file_preserves_existing_output() {
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("urls.json");
    let path = directory.path().join("menus.js");
    std::fs::write(&path, "previous menus").unwrap();
    for contents in [None, Some("not JSON"), Some(r#"[{"name":42}]"#)] {
        if let Some(contents) = contents {
            std::fs::write(&catalog, contents).unwrap();
        }
        let output = Command::new(env!("CARGO_BIN_EXE_food-finder"))
            .arg("--urls")
            .arg(&catalog)
            .arg("--output")
            .arg(&path)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains(&catalog.display().to_string())
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous menus");
    }
}

#[test]
fn invalid_location_identities_fail_before_fetching_or_writing_output() {
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("urls.json");
    let path = directory.path().join("menus.js");
    std::fs::write(&path, "previous menus").unwrap();
    for (locations, message) in [
        (
            json!([
                {"name": "Duplicate", "url": null},
                {"name": "Duplicate", "url": null}
            ]),
            "Duplicate location ID 'Duplicate'",
        ),
        (
            json!([
                {"name": "First", "url": "https://EXAMPLE.INVALID:443/"},
                {"name": "Second", "url": "https://example.invalid/"}
            ]),
            "Duplicate location ID 'example.invalid'",
        ),
        (
            json!([
                {"name": "Linked", "url": "https://example.invalid/"},
                {"name": "example.invalid", "url": null}
            ]),
            "Duplicate location ID 'example.invalid'",
        ),
        (
            json!([{"name": "", "url": null}]),
            "Location name must not be empty",
        ),
        (
            json!([{"name": " \t ", "url": "https://example.invalid/"}]),
            "Location name must not be empty",
        ),
    ] {
        std::fs::write(&catalog, locations.to_string()).unwrap();
        for named_output in [false, true] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_food-finder"));
            command.arg("--urls").arg(&catalog);
            if named_output {
                command.arg("--output").arg(&path);
            }
            let output = command.output().unwrap();
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            let stderr = String::from_utf8(output.stderr).unwrap();
            assert!(stderr.starts_with("Error:"), "{stderr}");
            assert!(stderr.contains(message), "{stderr}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous menus");
        }
    }
}
