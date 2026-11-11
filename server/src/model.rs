use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct TurnOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub phase: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub status: String,
    pub messages: Vec<Message>,
}

pub fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

pub fn status(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value["type"].as_str())
        .unwrap_or("unknown")
        .to_owned()
}

fn output_text(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value["text"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn message(item: &Value) -> Option<Message> {
    let kind = item["type"].as_str()?;
    let (role, body) = match kind {
        "userMessage" | "steeringUserMessage" => {
            let parts = item["content"].as_array()?;
            let body = parts
                .iter()
                .filter_map(|part| match part["type"].as_str() {
                    Some("text") => part["text"].as_str().map(str::to_owned),
                    Some("image" | "localImage") => Some("[图片附件]".to_owned()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            ("user", body)
        }
        "agentMessage" => ("assistant", text(item, "text")),
        "reasoning" => {
            let body = item["summary"]
                .as_array()?
                .iter()
                .map(output_text)
                .collect::<Vec<_>>()
                .join("\n");
            ("reasoning", body)
        }
        "functionCallOutput"
            if item["namespace"] == "codex_app"
                && matches!(
                    item["name"].as_str(),
                    Some("send_message_to_thread" | "create_thread")
                ) =>
        {
            let output = output_text(&item["output"]);
            let body = output
                .split_once("<input>")?
                .1
                .rsplit_once("</input>")?
                .0
                .to_owned();
            ("user", body)
        }
        "commandExecution" => (
            "tool",
            format!(
                "{}\n{}",
                text(item, "command"),
                output_text(item.get("aggregatedOutput").unwrap_or(&item["output"]))
                    .chars()
                    .take(20_000)
                    .collect::<String>()
            ),
        ),
        "mcpToolCall" => (
            "tool",
            format!(
                "{} · {} · {}",
                text(item, "server"),
                text(item, "tool"),
                text(item, "status")
            ),
        ),
        "dynamicToolCall" => (
            "tool",
            format!(
                "{} · {} · {}",
                text(item, "namespace"),
                text(item, "tool"),
                text(item, "status")
            ),
        ),
        "fileChange" => ("tool", "文件变更".to_owned()),
        _ => return None,
    };
    if body.is_empty() {
        return None;
    }
    Some(Message {
        id: text(item, "id"),
        kind: role.to_owned(),
        text: body,
        phase: item["phase"].as_str().map(str::to_owned),
    })
}

pub fn turn(value: &Value) -> Turn {
    Turn {
        id: value["turnId"]
            .as_str()
            .or_else(|| value["id"].as_str())
            .unwrap_or_default()
            .to_owned(),
        status: text(value, "status"),
        messages: value["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(message)
            .collect(),
    }
}

pub fn history_turns(page: &Value) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    for entry in page["data"].as_array().into_iter().flatten().rev() {
        let Some(message) = message(&entry["item"]) else {
            continue;
        };
        let turn_id = text(entry, "turnId");
        if let Some(last) = turns.last_mut().filter(|turn| turn.id == turn_id) {
            last.messages.push(message);
        } else {
            turns.push(Turn {
                id: turn_id,
                status: "unknown".to_owned(),
                messages: vec![message],
            });
        }
    }
    turns
}

pub fn stream_view(state: &Value) -> Value {
    let history = &state["turnHistory"]["history"];
    let mut turns: Vec<Turn> = if state["turnHistory"]["kind"] == "canonical" {
        history["islands"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|island| island["entries"].as_array().into_iter().flatten())
            .filter_map(|entry| entry["value"].as_str())
            .filter_map(|key| history["entitiesByKey"].get(key))
            .map(turn)
            .collect()
    } else {
        state["turns"]
            .as_array()
            .into_iter()
            .flatten()
            .map(turn)
            .collect()
    };
    let active_turn_id = turns
        .iter()
        .rev()
        .find(|turn| turn.status == "inProgress")
        .map(|turn| turn.id.clone());
    let complete = history["isComplete"].as_bool().unwrap_or(false);
    let recent = turns.len().saturating_sub(10);
    turns.drain(..recent);
    let mut remaining = 100;
    let mut truncated = recent > 0;
    for turn in turns.iter_mut().rev() {
        let remove = turn.messages.len().saturating_sub(remaining);
        truncated |= remove > 0;
        turn.messages.drain(..remove);
        remaining -= turn.messages.len();
    }
    turns.retain(|turn| !turn.messages.is_empty());
    json!({
        "turns": turns,
        "complete": complete && !truncated,
        "status": status(&state["threadRuntimeStatus"]),
        "activeTurnId": active_turn_id,
        "model": state["latestModel"],
        "title": state["title"],
        "waiting": state["requests"].as_array().map(|requests| !requests.is_empty()).unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_canonical_order_and_only_exposes_reasoning_summary() {
        let value = json!({"turnHistory":{"kind":"canonical","history":{
            "isComplete":true,
            "entitiesByKey":{
                "new":{"turnId":"b","status":"completed","items":[{"id":"r","type":"reasoning","summary":["Visible summary"],"content":["private"]}]},
                "old":{"turnId":"a","status":"completed","items":[{"id":"u","type":"userMessage","content":[{"type":"text","text":"hello"}]}]}
            },
            "islands":[{"entries":[{"value":"old"},{"value":"new"}]}]
        }},"threadRuntimeStatus":{"type":"idle"}});
        let view = stream_view(&value);
        assert_eq!(view["turns"][0]["id"], "a");
        assert_eq!(view["turns"][1]["messages"][0]["text"], "Visible summary");
        assert!(!view.to_string().contains("private"));
    }

    #[test]
    fn displays_an_in_progress_follow_up_as_a_user_message() {
        let item = json!({"id":"follow-up","type":"steeringUserMessage","content":[{"type":"text","text":"追加输入"}]});
        let rendered = message(&item).unwrap();
        assert_eq!(rendered.kind, "user");
        assert_eq!(rendered.text, "追加输入");
    }

    #[test]
    fn groups_item_pages_in_visible_order_without_exposing_private_reasoning() {
        let page = json!({"data":[
            {"turnId":"b","item":{"id":"reply","type":"agentMessage","text":"answer"}},
            {"turnId":"a","item":{"id":"reason","type":"reasoning","summary":["summary"],"content":["private"]}},
            {"turnId":"a","item":{"id":"user","type":"userMessage","content":[{"type":"text","text":"question"}]}}
        ]});
        let turns = history_turns(&page);
        assert_eq!(turns[0].id, "a");
        assert_eq!(turns[0].messages[0].id, "user");
        assert_eq!(turns[0].messages[1].text, "summary");
        assert_eq!(turns[1].messages[0].text, "answer");
    }

    #[test]
    fn bounds_a_long_live_turn_and_marks_it_as_partial() {
        let items = (0..150)
            .map(|index| {
                json!({
                    "id":index.to_string(),"type":"agentMessage","text":index.to_string()
                })
            })
            .collect::<Vec<_>>();
        let view = stream_view(&json!({"turns":[{"id":"long","items":items}]}));
        assert_eq!(view["turns"][0]["messages"].as_array().unwrap().len(), 100);
        assert_eq!(view["turns"][0]["messages"][0]["id"], "50");
        assert_eq!(view["complete"], false);
    }

    #[test]
    fn identifies_the_running_turn_before_any_visible_message_exists() {
        let view =
            stream_view(&json!({"turns":[{"id":"running","status":"inProgress","items":[]}]}));
        assert_eq!(view["activeTurnId"], "running");
        assert!(view["turns"].as_array().unwrap().is_empty());
    }

    #[test]
    fn displays_the_initial_prompt_created_through_the_desktop_tool() {
        let item = json!({"type":"functionCallOutput","id":"initial","namespace":"codex_app","name":"create_thread",
            "output":"<codex_delegation><source_thread_id>source</source_thread_id><input>first prompt</input></codex_delegation>"});
        let message = message(&item).unwrap();
        assert_eq!(message.kind, "user");
        assert_eq!(message.text, "first prompt");
    }
}
