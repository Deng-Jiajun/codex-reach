use serde_json::{Value, json};

pub struct Mode {
    pub id: &'static str,
    profile: &'static str,
    sandbox: &'static str,
    policy: &'static str,
    reviewer: &'static str,
}

pub const MODES: [Mode; 3] = [
    Mode {
        id: "ask",
        profile: ":workspace",
        sandbox: "workspace-write",
        policy: "on-request",
        reviewer: "user",
    },
    Mode {
        id: "auto",
        profile: ":workspace",
        sandbox: "workspace-write",
        policy: "on-request",
        reviewer: "guardian_subagent",
    },
    Mode {
        id: "full",
        profile: ":danger-full-access",
        sandbox: "danger-full-access",
        policy: "never",
        reviewer: "user",
    },
];

fn auto_reviewer(value: &str) -> bool {
    matches!(value, "guardian_subagent" | "auto_review")
}

impl Mode {
    pub fn settings(&self) -> Value {
        json!({
            "permissions": self.profile,
            "approvalPolicy": self.policy,
            "approvalsReviewer": self.reviewer,
        })
    }

    pub fn unavailable_reason(&self, requirements: &Value, config: &Value) -> Option<&'static str> {
        if self.id == "auto" && config["features"]["guardian_approval"] == false {
            return Some("电脑配置已关闭自动审批");
        }
        if !requirements["allowedPermissionProfiles"].is_null()
            && requirements["allowedPermissionProfiles"][self.profile] != true
        {
            return Some("电脑配置不允许使用此权限范围");
        }
        for (field, value, reason) in [
            (
                "allowedSandboxModes",
                self.sandbox,
                "电脑配置不允许使用此沙箱模式",
            ),
            (
                "allowedApprovalPolicies",
                self.policy,
                "电脑配置不允许使用此审批规则",
            ),
            (
                "allowedApprovalsReviewers",
                self.reviewer,
                "电脑配置不允许使用此审批者",
            ),
        ] {
            if let Some(allowed) = requirements[field].as_array() {
                let permitted = allowed.iter().any(|entry| {
                    entry == value
                        || (field == "allowedApprovalsReviewers"
                            && auto_reviewer(value)
                            && entry.as_str().is_some_and(auto_reviewer))
                });
                if !permitted {
                    return Some(reason);
                }
            }
        }
        None
    }
}

pub fn current(settings: &Value) -> &'static str {
    let profile = settings["activePermissionProfile"]["id"]
        .as_str()
        .or_else(|| settings["permissions"].as_str())
        .or_else(|| match settings["sandboxPolicy"]["type"].as_str()? {
            "dangerFullAccess" => Some(":danger-full-access"),
            "workspaceWrite" => Some(":workspace"),
            _ => None,
        });
    let reviewer = settings["approvalsReviewer"].as_str();
    MODES
        .iter()
        .find(|mode| {
            profile == Some(mode.profile)
                && settings["approvalPolicy"] == mode.policy
                && (reviewer == Some(mode.reviewer)
                    || (auto_reviewer(mode.reviewer) && reviewer.is_some_and(auto_reviewer)))
        })
        .map_or("custom", |mode| mode.id)
}

pub async fn applied(thread: &Value) -> anyhow::Result<Value> {
    let (Some(path), Some(id)) = (thread["path"].as_str(), thread["id"].as_str()) else {
        return Ok(Value::Null);
    };
    let path = std::path::PathBuf::from(path);
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Ok(Value::Null);
    }
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || match std::fs::File::open(path) {
        Ok(mut f) => last_applied(&mut f, &id),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.into()),
    })
    .await?
}

// Scan newest records first. Large image or tool-output lines need not be allocated.
fn last_applied(
    file: &mut (impl std::io::Read + std::io::Seek),
    id: &str,
) -> anyhow::Result<Value> {
    use std::io::SeekFrom;
    let mut pos = file.seek(SeekFrom::End(0))?;
    let mut end = pos;
    let mut block = vec![0; 32768];
    let mut line = Vec::new();
    while pos > 0 {
        let size = pos.min(block.len() as u64) as usize;
        pos -= size as u64;
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(&mut block[..size])?;
        let starts = block[..size]
            .iter()
            .enumerate()
            .rev()
            .filter_map(|(i, b)| (*b == b'\n').then_some(pos + i as u64 + 1))
            .chain((pos == 0).then_some(0));
        for start in starts {
            let len = end.saturating_sub(start);
            end = start.saturating_sub(1);
            if len == 0 || len > 1024 * 1024 {
                continue;
            }
            line.resize(len as usize, 0);
            file.seek(SeekFrom::Start(start))?;
            file.read_exact(&mut line)?;
            if !line
                .windows(b"thread_settings_applied".len())
                .any(|w| w == b"thread_settings_applied")
            {
                continue;
            }
            let Ok(row) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let p = &row["payload"];
            if row["type"] != "event_msg"
                || p["type"] != "thread_settings_applied"
                || p["thread_id"] != id
            {
                continue;
            }
            let s = &p["thread_settings"];
            let mode = current(
                &json!({"activePermissionProfile":s["active_permission_profile"],
                "approvalPolicy":s["approval_policy"],"approvalsReviewer":s["approvals_reviewer"]}),
            );
            return Ok(
                json!({"mode":mode,"appliedAt":row["timestamp"],"model":s["model"],"thinking":s["reasoning_effort"]}),
            );
        }
    }
    Ok(Value::Null)
}

pub fn choices(requirements: &Value, config: &Value) -> Value {
    Value::Array(
        MODES
            .iter()
            .map(|mode| {
                let reason = mode.unavailable_reason(requirements, config);
                json!({"mode": mode.id, "enabled": reason.is_none(), "reason": reason})
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_applied_uses_the_latest_complete_settings_for_this_thread() {
        let record = |id: &str, mode: &Mode, time: &str| {
            json!({"type":"event_msg","timestamp":time,
            "payload":{"thread_id":id,"type":"thread_settings_applied","thread_settings":{
                "active_permission_profile":{"id":mode.profile},"approval_policy":mode.policy,"approvals_reviewer":mode.reviewer}}})
        };
        let input = format!(
            "{}\n{}\n{}\n{}\n{{",
            record("target", &MODES[0], "first"),
            record("target", &MODES[2], "last"),
            "x".repeat(1024 * 1024 + 1),
            record("other", &MODES[1], "unrelated")
        );
        let mut file = std::io::Cursor::new(input);
        let settings = last_applied(&mut file, "target").unwrap();
        assert_eq!(settings["mode"], "full");
        assert_eq!(settings["appliedAt"], "last");
        assert_eq!(last_applied(&mut file, "missing").unwrap(), Value::Null);
    }

    #[test]
    fn desktop_modes_round_trip_complete_settings() {
        for mode in &MODES {
            assert_eq!(current(&mode.settings()), mode.id);
            assert!(mode.settings().get("sandboxPolicy").is_none());
            assert!(mode.settings().get("activePermissionProfile").is_none());
        }
        assert_eq!(
            current(
                &json!({"permissions":":workspace","approvalPolicy":"on-request","approvalsReviewer":"auto_review"})
            ),
            "auto"
        );
    }

    #[test]
    fn incomplete_and_custom_combinations_remain_custom() {
        assert_eq!(current(&json!({"approvalPolicy":"never"})), "custom");
        assert_eq!(
            current(
                &json!({"permissions":":workspace","approvalPolicy":"never","approvalsReviewer":"user"})
            ),
            "custom"
        );
        assert_eq!(
            current(
                &json!({"permissions":":workspace","activePermissionProfile":{"id":"project-custom"},"approvalPolicy":"on-request","approvalsReviewer":"user"})
            ),
            "custom"
        );
    }

    #[test]
    fn all_desktop_constraints_are_respected() {
        for mode in &MODES {
            assert!(
                mode.unavailable_reason(&Value::Null, &Value::Null)
                    .is_none()
            );
            for field in [
                "allowedSandboxModes",
                "allowedApprovalPolicies",
                "allowedApprovalsReviewers",
            ] {
                let mut requirements = json!({});
                requirements[field] = json!([]);
                assert!(
                    mode.unavailable_reason(&requirements, &Value::Null)
                        .is_some()
                );
            }
            assert!(
                mode.unavailable_reason(&json!({"allowedPermissionProfiles":{}}), &Value::Null)
                    .is_some()
            );
        }
        assert!(
            MODES[1]
                .unavailable_reason(
                    &json!({"allowedApprovalsReviewers":["auto_review"]}),
                    &Value::Null
                )
                .is_none()
        );
        assert!(
            MODES[1]
                .unavailable_reason(
                    &Value::Null,
                    &json!({"features":{"guardian_approval":false}})
                )
                .is_some()
        );
    }
}
