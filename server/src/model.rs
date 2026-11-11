use serde::Serialize;
use serde_json::{Value, json};

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
        "userMessage" => {
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
            if item["namespace"] == "codex_app" && item["name"] == "send_message_to_thread" =>
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
                output_text(&item["output"])
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

pub fn stream_view(state: &Value) -> Value {
    let history = &state["turnHistory"]["history"];
    let turns: Vec<Turn> = if state["turnHistory"]["kind"] == "canonical" {
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
    let recent = turns.len().saturating_sub(10);
    json!({
        "turns": &turns[recent..],
        "complete": history["isComplete"].as_bool().unwrap_or(false) && recent == 0,
        "status": status(&state["threadRuntimeStatus"]),
        "model": state["latestModel"],
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
}
