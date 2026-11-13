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
        .or_else(|| settings["permissions"].as_str());
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
