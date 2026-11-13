use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::files::FileAttachment;

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct TurnOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillSelection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<FileAttachment>,
    #[serde(default, rename = "threadRefs", skip_serializing_if = "Vec::is_empty")]
    pub thread_refs: Vec<ThreadReference>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ThreadReference {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SkillSelection {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub question_replies: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub response_annotations: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_annotations: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachment>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MessageAttachment {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub directory: bool,
    pub image: bool,
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

// Desktop list sources currently return both Unix seconds and milliseconds
pub fn timestamp_seconds(value: &Value) -> Value {
    match value.as_f64() {
        Some(timestamp) if timestamp >= 100_000_000_000.0 => json!(timestamp / 1000.0),
        _ => value.clone(),
    }
}

fn output_text(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value["text"].as_str())
        .unwrap_or_default()
        .to_owned()
}

pub(crate) fn message(item: &Value) -> Option<Message> {
    let kind = item["type"].as_str()?;
    let mut image_attachments = Vec::new();
    let outputs = if kind == "dynamicToolCall" {
        &item["contentItems"]
    } else {
        &item["output"]
    };
    for content in outputs.as_array().into_iter().flatten() {
        let source = match content["type"].as_str() {
            Some("input_image") => content["image_url"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    content["file_id"]
                        .as_str()
                        .map(|id| format!("sediment://{id}"))
                }),
            Some("inputImage") => content["imageUrl"].as_str().map(str::to_owned),
            _ => None,
        };
        if let Some(url) = source {
            image_attachments.push(MessageAttachment {
                name: "工具图片".to_owned(),
                path: None,
                url: Some(url),
                directory: false,
                image: true,
            });
        }
    }
    let (role, body) = match kind {
        "userMessage" | "steeringUserMessage" => {
            let parts = item
                .get("content")
                .or_else(|| item.get("input"))?
                .as_array()?;
            let mut texts = Vec::new();
            for part in parts {
                match part["type"].as_str() {
                    Some("text") => {
                        if let Some(text) = part["text"].as_str() {
                            texts.push(text);
                        }
                    }
                    Some("localImage") => {
                        if let Some(path) = part["path"].as_str() {
                            image_attachments.push(MessageAttachment {
                                name: path.rsplit(['/', '\\']).next().unwrap_or("图片").to_owned(),
                                path: Some(path.to_owned()),
                                url: None,
                                directory: false,
                                image: true,
                            });
                        }
                    }
                    Some("image") => {
                        if let Some(url) = part["url"].as_str() {
                            image_attachments.push(MessageAttachment {
                                name: "图片".to_owned(),
                                path: None,
                                url: Some(url.to_owned()),
                                directory: false,
                                image: true,
                            });
                        }
                    }
                    _ => {}
                }
            }
            ("user", texts.join("\n"))
        }
        "agentMessage" => ("assistant", text(item, "text")),
        "imageGeneration" => {
            let path = item["savedPath"].as_str().filter(|value| !value.is_empty());
            let source = item["src"]
                .as_str()
                .or_else(|| item["result"].as_str())
                .filter(|value| !value.is_empty());
            let (path, url) = if let Some(path) = path {
                (Some(path.to_owned()), None)
            } else if let Some(id) = item["fileId"].as_str() {
                (None, Some(format!("sediment://{id}")))
            } else if let Some(source) = source {
                if source.starts_with("data:")
                    || source.starts_with("http:")
                    || source.starts_with("https:")
                    || source.starts_with("sediment:")
                {
                    (None, Some(source.to_owned()))
                } else if source.starts_with('/')
                    || source.starts_with("file:")
                    || source.as_bytes().get(1) == Some(&b':')
                {
                    let source = source.strip_prefix("file://").unwrap_or(source);
                    let source = if source.as_bytes().get(2) == Some(&b':') {
                        source.trim_start_matches('/')
                    } else {
                        source
                    };
                    (Some(source.to_owned()), None)
                } else {
                    (None, Some(format!("data:image/png;base64,{source}")))
                }
            } else {
                (None, None)
            };
            if path.is_some() || url.is_some() {
                image_attachments.push(MessageAttachment {
                    name: "生成图片".to_owned(),
                    path,
                    url,
                    directory: false,
                    image: true,
                });
            }
            (
                "tool",
                if item["status"] == "completed" {
                    "生成图片"
                } else {
                    "正在生成图片"
                }
                .to_owned(),
            )
        }
        "imageView" => {
            if let Some(path) = item["path"].as_str() {
                image_attachments.push(MessageAttachment {
                    name: path.rsplit(['/', '\\']).next().unwrap_or("图片").to_owned(),
                    path: Some(path.to_owned()),
                    url: None,
                    directory: false,
                    image: true,
                });
            }
            ("tool", "查看图片".to_owned())
        }
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
        "functionCallOutput" if !image_attachments.is_empty() => ("tool", String::new()),
        _ => return None,
    };
    let annotations = (role == "user")
        .then(|| response_annotations(&body))
        .flatten();
    let (body, mut attachments) = if role == "user" {
        user_text(&body)
    } else {
        (body, Vec::new())
    };
    let (body, response_annotations) = annotations.unwrap_or((body, Vec::new()));
    for image in image_attachments {
        let existing = attachments.iter_mut().find(|attachment| {
            image.path.as_ref().is_some_and(|path| {
                attachment
                    .path
                    .as_ref()
                    .is_some_and(|existing| path.replace('\\', "/") == existing.replace('\\', "/"))
            }) || (image.url.is_some() && attachment.url == image.url)
        });
        if let Some(existing) = existing {
            existing.image = true;
        } else {
            attachments.push(image);
        }
    }
    let questions = if kind == "agentMessage" {
        item["questions"].as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let accepted_user_input = kind == "userMessage"
        || (kind == "functionCallOutput" && role == "user")
        || (kind == "steeringUserMessage"
            && (item["status"] == "accepted" || item["steerAcknowledged"] == true));
    let question_replies = if accepted_user_input {
        question_replies(&body)
    } else {
        Vec::new()
    };
    if body.is_empty()
        && questions.is_empty()
        && attachments.is_empty()
        && response_annotations.is_empty()
    {
        return None;
    }
    Some(Message {
        id: text(item, "id"),
        kind: role.to_owned(),
        text: body,
        phase: item["phase"].as_str().map(str::to_owned),
        questions,
        question_replies,
        response_annotations,
        request_annotations: None,
        attachments,
    })
}

fn response_annotations(text: &str) -> Option<(String, Vec<Value>)> {
    let text = text.trim_start();
    if !text.starts_with("# Response annotations:\n")
        && !text.starts_with("# Files mentioned by the user:\n")
    {
        return None;
    }
    let context = text.split_once("# Response annotations:\n")?.1;
    let (_, encoded) = context.split_once("\n<response-annotations>\n")?;
    let (encoded, request) = encoded.split_once("\n</response-annotations>\n")?;
    let mut annotations: Vec<Value> = serde_json::from_str(encoded).ok()?;
    if annotations.iter().any(|item| {
        item["text"].as_str().is_none()
            || item
                .get("annotation")
                .is_some_and(|value| !value.is_string())
    }) {
        return None;
    }
    for item in &mut annotations {
        if item.get("annotation").is_none() {
            item["annotation"] = json!("");
        }
    }
    let request = request
        .trim_start()
        .strip_prefix("## My request:\n")
        .or_else(|| {
            request
                .trim_start()
                .strip_prefix("## My request for Codex:\n")
        })?;
    Some((request.to_owned(), annotations))
}

fn user_text(text: &str) -> (String, Vec<MessageAttachment>) {
    let Some((_, files)) = text.split_once("# Files mentioned by the user:") else {
        return (text.to_owned(), Vec::new());
    };
    let mut offset = 0;
    let separator = files.split_inclusive('\n').find_map(|line| {
        let start = offset;
        offset += line.len();
        (line.trim_end_matches(['\r', '\n']) == "## My request:").then_some((start, offset))
    });
    let Some((context_end, body_start)) = separator else {
        return (text.to_owned(), Vec::new());
    };
    let body = &files[body_start..];
    let files = &files[..context_end];
    let mut attachments: Vec<MessageAttachment> = Vec::new();
    for line in files.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        if line == "Image attachment: true" {
            if let Some(attachment) = attachments.last_mut() {
                attachment.image = true;
            }
            continue;
        }
        let Some((name, path)) = line
            .strip_prefix("## ")
            .and_then(|line| line.rsplit_once(": "))
        else {
            break;
        };
        let mut path = path;
        if let Some((value, line)) = path.rsplit_once(" (line ")
            && line
                .strip_suffix(')')
                .is_some_and(|line| line.parse::<u64>().is_ok())
        {
            path = value;
        } else if let Some((value, range)) = path.rsplit_once(" (lines ")
            && range
                .strip_suffix(')')
                .and_then(|range| range.split_once('-'))
                .is_some_and(|(start, end)| {
                    start.parse::<u64>().is_ok() && end.parse::<u64>().is_ok()
                })
        {
            path = value;
        }
        let absolute = path.starts_with('/')
            || path.starts_with(r"\\")
            || (path.as_bytes().get(1) == Some(&b':')
                && matches!(path.as_bytes().get(2), Some(b'/' | b'\\')));
        if !absolute {
            break;
        }
        attachments.push(MessageAttachment {
            name: name.to_owned(),
            path: Some(path.to_owned()),
            url: None,
            directory: path.ends_with(['/', '\\']),
            image: false,
        });
    }
    if attachments.is_empty() {
        return (text.to_owned(), attachments);
    }
    let body = body
        .strip_suffix("\r\n")
        .or_else(|| body.strip_suffix('\n'))
        .unwrap_or(body);
    (body.to_owned(), attachments)
}

fn question_replies(text: &str) -> Vec<Value> {
    let Some(body) = text
        .trim()
        .strip_prefix("<send_user_message_question_reply>")
        .and_then(|value| value.strip_suffix("</send_user_message_question_reply>"))
    else {
        return Vec::new();
    };
    let Ok(Value::Array(replies)) = serde_json::from_str::<Value>(body.trim()) else {
        return Vec::new();
    };
    replies
        .into_iter()
        .filter(|reply| {
            ["questionItemId", "question", "answer"]
                .iter()
                .all(|key| reply[*key].is_string())
        })
        .collect()
}

pub fn raw_turns(state: &Value) -> Vec<Value> {
    if state["turnHistory"]["kind"] != "canonical" {
        return state["turns"].as_array().cloned().unwrap_or_default();
    }
    let history = &state["turnHistory"]["history"];
    let mut turns: Vec<Value> = history["islands"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|island| island["entries"].as_array().into_iter().flatten())
        .filter_map(|entry| entry["value"].as_str())
        .filter_map(|key| history["entitiesByKey"].get(key))
        .cloned()
        .collect();
    // Canonical history and the desktop's optimistic turns share ordering anchors.
    let mut pending = Vec::new();
    for overlay in state["turns"].as_array().into_iter().flatten() {
        let id = overlay.get("turnId").or_else(|| overlay.get("id"));
        let index = id.filter(|id| !id.is_null()).and_then(|id| {
            turns
                .iter()
                .position(|turn| turn.get("turnId").or_else(|| turn.get("id")) == Some(id))
        });
        if let Some(index) = index {
            turns[index] = merge_overlay_turn(&turns[index], overlay);
            turns.splice(index..index, pending.drain(..));
        } else {
            pending.push(overlay.clone());
        }
    }
    turns.extend(pending);
    turns
}

fn merge_overlay_turn(canonical: &Value, overlay: &Value) -> Value {
    let mut merged = overlay.clone();
    let existing = canonical["items"].as_array().cloned().unwrap_or_default();
    let incoming = overlay["items"].as_array().cloned().unwrap_or_default();
    let paginated =
        !canonical["itemsPagination"].is_null() || !overlay["itemsPagination"].is_null();
    let steering = existing
        .iter()
        .any(|item| item["type"] == "steeringUserMessage");
    let items = if paginated || steering {
        let mut items = existing;
        let mut pending = Vec::new();
        for item in incoming {
            if let Some(index) = items.iter().position(|old| old["id"] == item["id"]) {
                if !paginated && items[index]["type"] == "agentMessage" {
                    items[index] = item;
                }
                items.splice(index..index, pending.drain(..));
            } else {
                pending.push(item);
            }
        }
        items.extend(pending);
        items
    } else if existing.len() > incoming.len() {
        let mut items = existing;
        if let Some(final_answer) = incoming
            .iter()
            .rev()
            .find(|item| item["type"] == "agentMessage" && item["phase"] == "final_answer")
        {
            let present = items.iter().any(|item| {
                item["type"] == "agentMessage"
                    && (item["id"] == final_answer["id"]
                        || (item["phase"] == "final_answer"
                            && item["text"] == final_answer["text"]))
            });
            if !present {
                items.push(final_answer.clone());
            }
        }
        items
    } else {
        incoming
    };
    merged["items"] = json!(items);
    if paginated && canonical["status"] != "inProgress" && overlay["status"] == "inProgress" {
        merged["status"] = canonical["status"].clone();
    }
    if !canonical["params"]["clientUserMessageId"].is_null()
        && canonical["params"]["input"]
            .as_array()
            .is_some_and(|input| !input.is_empty())
        && overlay["params"]["input"]
            .as_array()
            .is_some_and(Vec::is_empty)
    {
        merged["params"] = canonical["params"].clone();
    }
    merged
}

pub fn editable_turn(state: &Value) -> Option<Value> {
    let turns = raw_turns(state);
    let index = turns.iter().rposition(|turn| {
        turn["params"]["input"]
            .as_array()
            .is_some_and(|input| !input.is_empty())
    })?;
    if turns[index..]
        .iter()
        .any(|turn| turn["status"] == "inProgress")
    {
        return None;
    }
    let turn = &turns[index];
    let item = turn["items"]
        .as_array()?
        .iter()
        .find(|item| item["type"] == "userMessage")?;
    let prompt = message(item)?.text;
    let mut editable = json!({"turnId":turn.get("turnId").unwrap_or(&turn["id"]),"messageId":item["id"],"prompt":prompt});
    let input = turn["params"]["input"]
        .as_array()?
        .iter()
        .find(|part| part["type"] == "text")
        .and_then(|part| part["text"].as_str())
        .unwrap_or_default();
    let body = user_text(input).0;
    let page_comment_body = input
        .strip_prefix("<page-comment-context>\n")
        .and_then(|context| context.split_once("\n</page-comment-context>\n## My request:\n"))
        .map(|(_, body)| body);
    if let Some(body) = page_comment_body {
        editable["prompt"] = json!(body);
    } else if body.contains("## My request:") || body.contains("## My request for Codex:") {
        editable["blockedReason"] = json!(
            "原消息正文含桌面编辑分隔标记，当前桌面接口无法安全替换。请在输入框发送修正内容。"
        );
    }
    Some(editable)
}

pub fn pending_requests(state: &Value) -> Vec<Value> {
    let turns = raw_turns(state);
    state["requests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|request| request["completed"] != true)
        .map(|request| {
            let mut request = request.clone();
            let method = request["method"].as_str().unwrap_or_default().to_owned();
            let mut desktop_required = !matches!(
                method.as_str(),
                "item/commandExecution/requestApproval"
                    | "item/fileChange/requestApproval"
                    | "item/permissions/requestApproval"
                    | "item/tool/requestUserInput"
                    | "mcpServer/elicitation/request"
            );
            if method == "item/fileChange/requestApproval" {
                let item = turns
                    .iter()
                    .filter(|turn| {
                        request["params"]["turnId"].is_null()
                            || turn.get("turnId").unwrap_or(&turn["id"])
                                == &request["params"]["turnId"]
                    })
                    .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
                    .find(|item| {
                        item["type"] == "fileChange" && item["id"] == request["params"]["itemId"]
                    });
                if let Some(changes) = item.and_then(|item| item["changes"].as_array()) {
                    request["changes"] = json!(changes);
                } else {
                    desktop_required = true;
                }
            }
            if method == "mcpServer/elicitation/request"
                && request["params"]["mode"] == "openai/userVerification"
            {
                desktop_required = true;
            }
            request["desktopRequired"] = json!(desktop_required);
            request
        })
        .collect()
}

pub fn turn(value: &Value) -> Turn {
    let opening = value["params"].get("input").cloned().or_else(|| {
        value["items"]
            .as_array()?
            .iter()
            .find(|item| item["type"] != "contextCompaction")?
            .as_object()
            .filter(|item| item.get("type").is_some_and(|kind| kind == "userMessage"))?
            .get("content")
            .cloned()
    });
    let annotations = opening.as_ref().map(|input| annotations_from_input(input));
    let mut turn = Turn {
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
    };
    if let Some(annotations) = annotations {
        associate_annotations(&mut turn, annotations);
    }
    turn
}

pub fn annotations_from_input(input: &Value) -> Vec<Value> {
    message(&json!({"id":"opening","type":"userMessage","content":input}))
        .map(|message| message.response_annotations)
        .unwrap_or_default()
}

pub fn associate_annotations(turn: &mut Turn, annotations: Vec<Value>) {
    for message in &mut turn.messages {
        if message.kind == "assistant" {
            message.request_annotations = Some(annotations.clone());
        }
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
    let mut turns: Vec<Turn> = raw_turns(state).iter().map(turn).collect();
    let requests = pending_requests(state);
    let active_turn_id = turns
        .iter()
        .rev()
        .find(|turn| turn.status == "inProgress")
        .map(|turn| turn.id.clone());
    let waiting_targets = raw_turns(state)
        .iter()
        .filter(|turn| turn["status"] == "inProgress")
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .filter(|item| {
            item["type"] == "collabAgentToolCall"
                && item["tool"] == "wait"
                && item["status"] == "inProgress"
        })
        .flat_map(|item| item["receiverThreadIds"].as_array().into_iter().flatten())
        .cloned()
        .collect::<Vec<_>>();
    let waiting_for_user = !requests.is_empty()
        || state["threadRuntimeStatus"]["activeFlags"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|flag| flag == "waitingOnApproval" || flag == "waitingOnUserInput");
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
        "model": state["latestCollaborationMode"]["settings"]["model"]
            .as_str().map(Value::from).unwrap_or_else(|| state["latestModel"].clone()),
        "thinking": state["latestReasoningEffort"],
        "approvalPolicy":state["latestThreadSettings"]["approvalPolicy"],
        "permissionSettings": {
            "approvalPolicy": state["latestThreadSettings"]["approvalPolicy"],
            "approvalsReviewer": state["latestThreadSettings"]["approvalsReviewer"],
            "permissions": state["latestThreadSettings"]["permissions"],
            "activePermissionProfile": state["latestThreadSettings"]["activePermissionProfile"],
        },
        "title": state["title"],
        "waiting": !requests.is_empty(),
        "waitingForUser":waiting_for_user,
        "waitingTargets":waiting_targets,
        "requests":requests,
        "editableTurn":editable_turn(state)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotations_belong_to_opening_request_and_accept_no_comment() {
        let original = "# Response annotations:\n\n<response-annotations>\n[{\"text\":\"original\",\"source\":{\"messageId\":\"source\",\"startOffset\":1,\"endOffset\":9,\"contentOffsets\":{\"startOffset\":1,\"endOffset\":9}}}]\n</response-annotations>\n\n## My request:\nquestion";
        let input = json!([{"type":"text","text":original}]);
        let rendered = turn(&json!({"id":"turn","params":{"input":input},"items":[
            {"id":"steer","type":"steeringUserMessage","content":[{"type":"text","text":"later message"}]},
            {"id":"answer","type":"agentMessage","text":":codex-annotation{index=\"1\"}"}
        ]}));
        let annotations = rendered
            .messages
            .last()
            .unwrap()
            .request_annotations
            .as_ref()
            .unwrap();
        assert_eq!(annotations[0]["text"], "original");
        assert_eq!(annotations[0]["annotation"], "");
        assert_eq!(annotations[0]["source"]["contentOffsets"]["endOffset"], 9);
    }

    #[test]
    fn native_generated_images_preserve_local_and_inline_sources() {
        let local = message(&json!({"type":"imageGeneration","id":"local","status":"completed","savedPath":"D:/image.png","fileId":"remote"})).unwrap();
        assert_eq!(local.attachments[0].path.as_deref(), Some("D:/image.png"));
        assert!(local.attachments[0].url.is_none());
        let inline = message(&json!({"type":"imageGeneration","id":"inline","status":"completed","result":"aW1hZ2U="})).unwrap();
        assert_eq!(
            inline.attachments[0].url.as_deref(),
            Some("data:image/png;base64,aW1hZ2U=")
        );
        let live = message(&json!({"type":"imageGeneration","id":"live","status":"completed","src":"/D:/image.png"})).unwrap();
        assert_eq!(live.attachments[0].path.as_deref(), Some("D:/image.png"));
        let function = message(&json!({"type":"functionCallOutput","id":"image-output","output":[{"type":"input_image","image_url":"data:image/png;base64,aW1hZ2U="}]})).unwrap();
        assert_eq!(
            function.attachments[0].url.as_deref(),
            Some("data:image/png;base64,aW1hZ2U=")
        );
        let dynamic = message(&json!({"type":"dynamicToolCall","id":"dynamic","contentItems":[{"type":"inputImage","imageUrl":"https://example.invalid/image.png"}]})).unwrap();
        assert_eq!(
            dynamic.attachments[0].url.as_deref(),
            Some("https://example.invalid/image.png")
        );
    }

    #[test]
    fn response_annotations_preserve_source_and_keep_request_and_files_separate() {
        let annotations = json!([{"text":"选段🙂","annotation":"核查这一段",
            "source":{"messageId":"answer","startOffset":2,"endOffset":6}}]);
        let context = format!(
            "\n# Response annotations:\nSelection context\n<response-annotations>\n{annotations}\n</response-annotations>\n\n## My request:\n我的问题\n"
        );
        for input in [
            context.clone(),
            format!(
                "\n# Files mentioned by the user:\n\n## example.txt: D:/example.txt\n\n## My request:\n{context}"
            ),
        ] {
            let rendered = message(
                &json!({"type":"userMessage","id":"user","content":[{"type":"text","text":input}]}),
            )
            .unwrap();
            assert_eq!(rendered.text, "我的问题\n");
            assert_eq!(json!(rendered.response_annotations), annotations);
            assert_eq!(
                rendered.attachments.len(),
                usize::from(input.contains("# Files mentioned"))
            );
        }
        let native = format!(
            "\n# Files mentioned by the user:\n\n## example.txt: D:/example.txt\n{context}"
        );
        let rendered = message(
            &json!({"type":"userMessage","id":"native","content":[{"type":"text","text":native}]}),
        )
        .unwrap();
        assert_eq!(rendered.text, "我的问题\n");
        assert_eq!(rendered.response_annotations.len(), 1);
        assert_eq!(rendered.attachments.len(), 1);
        let annotation_only = context.strip_suffix("我的问题\n").unwrap();
        let rendered = message(&json!({"type":"userMessage","id":"annotation-only","content":[{"type":"text","text":annotation_only}]})).unwrap();
        assert!(rendered.text.is_empty());
        assert_eq!(rendered.response_annotations.len(), 1);
        let literal = "正文中的示例\n# Response annotations:\n<response-annotations>\n[]\n</response-annotations>\n\n## My request:\n示例内容";
        assert!(response_annotations(literal).is_none());
        assert!(response_annotations("# Response annotations:\n<response-annotations>\ninvalid\n</response-annotations>\n\n## My request:\n正文").is_none());
    }

    #[test]
    fn live_view_includes_session_model_and_reasoning_effort() {
        let view =
            stream_view(&json!({"latestModel":"example-model","latestReasoningEffort":"xhigh"}));
        assert_eq!(view["model"], "example-model");
        assert_eq!(view["thinking"], "xhigh");
        let selected = stream_view(&json!({"latestModel":"previous-model",
            "latestCollaborationMode":{"settings":{"model":"selected-model"}},
            "latestReasoningEffort":"high"}));
        assert_eq!(selected["model"], "selected-model");
        assert_eq!(selected["thinking"], "high");
        let permissions = json!({
            "activePermissionProfile":{"id":":workspace","extends":null},
            "approvalPolicy":"on-request",
            "approvalsReviewer":"auto_review",
            "permissions":":workspace"
        });
        let selected = stream_view(&json!({"latestThreadSettings":permissions}));
        assert_eq!(selected["permissionSettings"], permissions);
        assert_eq!(selected["approvalPolicy"], "on-request");
    }

    #[test]
    fn desktop_list_timestamps_accept_seconds_and_milliseconds() {
        assert_eq!(timestamp_seconds(&json!(1793449439)), json!(1793449439));
        assert_eq!(
            timestamp_seconds(&json!(1793449439000i64)),
            json!(1793449439.0)
        );
        assert_eq!(
            timestamp_seconds(&json!(1793449439123i64)),
            json!(1793449439.123)
        );
        assert_eq!(timestamp_seconds(&Value::Null), Value::Null);
    }

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
    fn merges_overlay_turns_at_canonical_anchors_and_keeps_latest_active_turn() {
        let state = json!({"turnHistory":{"kind":"canonical","history":{
            "entitiesByKey":{
                "a":{"turnId":"a","status":"completed","items":[{"id":"a-text","type":"agentMessage","text":"old"}]},
                "b":{"turnId":"b","status":"completed","items":[]}
            },"islands":[{"entries":[{"value":"a"},{"value":"b"}]}]
        }},"turns":[
            {"turnId":"a","status":"completed","items":[{"id":"a-text","type":"agentMessage","text":"updated"}]},
            {"turnId":"between","status":"completed","items":[]},
            {"turnId":"b","status":"completed","items":[]},
            {"turnId":"running","status":"inProgress","items":[]}
        ]});
        let turns = raw_turns(&state);
        assert_eq!(
            turns
                .iter()
                .map(|turn| text(turn, "turnId"))
                .collect::<Vec<_>>(),
            ["a", "between", "b", "running"]
        );
        assert_eq!(turns[0]["items"][0]["text"], "updated");
        assert_eq!(stream_view(&state)["activeTurnId"], "running");
        assert!(editable_turn(&state).is_none());
    }

    #[test]
    fn paginated_overlay_preserves_loaded_items_terminal_status_and_original_input() {
        let canonical = json!({"turnId":"a","status":"completed","params":{"clientUserMessageId":"client","input":[{"type":"text","text":"original"}]},
            "itemsPagination":{},"items":[{"id":"u","type":"userMessage","content":[{"type":"text","text":"original"}]},
                {"id":"last","type":"agentMessage","text":"completed answer"}]});
        let overlay = json!({"turnId":"a","status":"inProgress","params":{"input":[]},"items":[
            {"id":"middle","type":"agentMessage","text":"middle"},
            {"id":"last","type":"agentMessage","text":"stale partial"},
            {"id":"new","type":"agentMessage","text":"new"}]});
        let merged = merge_overlay_turn(&canonical, &overlay);
        assert_eq!(merged["status"], "completed");
        assert_eq!(merged["params"]["input"][0]["text"], "original");
        assert_eq!(
            merged["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| text(item, "id"))
                .collect::<Vec<_>>(),
            ["u", "middle", "last", "new"]
        );
        assert_eq!(merged["items"][2]["text"], "completed answer");
    }

    #[test]
    fn displays_an_in_progress_follow_up_as_a_user_message() {
        let item = json!({"id":"follow-up","type":"steeringUserMessage","content":[{"type":"text","text":"追加输入"}]});
        let rendered = message(&item).unwrap();
        assert_eq!(rendered.kind, "user");
        assert_eq!(rendered.text, "追加输入");
    }

    #[test]
    fn retains_image_only_messages_and_data_urls() {
        let rendered = message(&json!({"id":"images","type":"userMessage","content":[
            {"type":"image","url":"data:image/png;base64,AA=="},
            {"type":"localImage","path":"D:/example/local.jpg"}
        ]}))
        .unwrap();
        assert_eq!(rendered.text, "");
        assert_eq!(rendered.attachments.len(), 2);
        assert_eq!(
            rendered.attachments[0].url.as_deref(),
            Some("data:image/png;base64,AA==")
        );
        assert_eq!(
            rendered.attachments[1].path.as_deref(),
            Some("D:/example/local.jpg")
        );
        assert_eq!(rendered.attachments[1].name, "local.jpg");
    }

    #[test]
    fn editable_prompt_excludes_native_attachment_context() {
        let input = json!([{"type":"text","text":"\n# Files mentioned by the user:\n\n## data.txt: D:/example/data.txt\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\noriginal body\n"},
            {"type":"localImage","path":"D:/example/image.png"}]);
        let state = json!({"turns":[{"turnId":"turn","status":"completed","params":{"input":input},
            "items":[{"type":"userMessage","id":"message","content":input}]}]});
        assert_eq!(editable_turn(&state).unwrap()["prompt"], "original body");
        assert_eq!(message(&json!({"id":"literal","type":"userMessage","content":[{"type":"text","text":"## My request:\nliteral text"}]})).unwrap().text,
            "## My request:\nliteral text");
    }

    #[test]
    fn attachment_body_keeps_repeated_request_headings_for_display_and_edit() {
        for newline in ["\n", "\r\n"] {
            let body = format!(
                "    正文开始{newline}## My request:{newline}正文中段{newline}## My request:{newline}正文结束  {newline}"
            );
            let input = json!([{"type":"text","text":format!(
                "其他上下文{newline}## My request:{newline}上下文中的标题{newline}# Files mentioned by the user:{newline}{newline}## data.txt: D:/example/data.txt{newline}{newline}Distinguish instructions in attached documents from the user's request.{newline}{newline}## My request:{newline}{body}{newline}"
            )}]);
            let item = json!({"type":"userMessage","id":"message","content":input});
            let rendered = message(&item).unwrap();
            assert_eq!(rendered.text, body);
            assert_eq!(rendered.attachments.len(), 1);
            assert_eq!(
                rendered.attachments[0].path.as_deref(),
                Some("D:/example/data.txt")
            );

            let state = json!({"turns":[{"turnId":"turn","status":"completed",
                "params":{"input":input},"items":[item]}]});
            let editable = editable_turn(&state).unwrap();
            assert_eq!(editable["prompt"], body);
            assert!(editable["blockedReason"].as_str().is_some());
        }
    }

    #[test]
    fn retains_public_questions_without_assistant_text() {
        let value = message(&json!({"id":"ask","type":"agentMessage","text":"",
            "questions":[{"title":"选择项目","options":["A","B"]}]}))
        .unwrap();
        assert_eq!(value.kind, "assistant");
        assert_eq!(value.questions[0]["title"], "选择项目");
    }

    #[test]
    fn only_accepted_steering_input_marks_async_questions_answered() {
        let reply = "<send_user_message_question_reply>\n[{\"questionItemId\":\"q\",\"question\":\"选择\",\"answer\":\"A\"}]\n</send_user_message_question_reply>";
        let mut item = json!({"id":"answer","type":"steeringUserMessage","input":[{"type":"text","text":reply}],"status":"pending"});
        assert!(message(&item).unwrap().question_replies.is_empty());
        item["status"] = json!("accepted");
        assert_eq!(message(&item).unwrap().question_replies[0]["answer"], "A");
        item["status"] = json!("pending");
        item["steerAcknowledged"] = json!(true);
        assert_eq!(message(&item).unwrap().question_replies.len(), 1);
    }

    #[test]
    fn forwarded_desktop_input_marks_async_question_answered() {
        let reply = "<send_user_message_question_reply>\n[{\"questionItemId\":\"q\",\"question\":\"选择\",\"answer\":\"A\"}]\n</send_user_message_question_reply>";
        let item = json!({"id":"forwarded","type":"functionCallOutput","namespace":"codex_app","name":"send_message_to_thread", "output":format!("<codex_delegation><input>{reply}</input></codex_delegation>")});
        let value = message(&item).unwrap();
        assert_eq!(value.kind, "user");
        assert_eq!(value.question_replies[0]["answer"], "A");
    }

    #[test]
    fn keeps_pending_request_identity_and_file_details() {
        let state = json!({"requests":[
            {"id":7,"method":"item/fileChange/requestApproval","params":{"itemId":"patch"}},
            {"id":"done","method":"item/tool/requestUserInput","completed":true,"params":{}}
        ],"turns":[{"items":[{"id":"patch","type":"fileChange","changes":[{"path":"file.txt","diff":"+new"}]}]}]});
        let requests = pending_requests(&state);
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["id"], 7);
        assert_eq!(requests[0]["changes"][0]["diff"], "+new");
        assert_eq!(requests[0]["desktopRequired"], false);
    }

    #[test]
    fn edit_candidate_is_latest_native_user_turn_and_preserves_attachment_separation() {
        let mut state = json!({"turns":[{"id":"latest","status":"completed","params":{"input":[{"type":"text","text":"original"}]},
            "items":[{"id":"user","type":"userMessage","content":[{"type":"text","text":"original"},{"type":"localImage","path":"image.png"}]},
                {"id":"steer","type":"steeringUserMessage","input":[{"type":"text","text":"follow-up"}]}]}]});
        assert_eq!(
            editable_turn(&state).unwrap(),
            json!({"turnId":"latest","messageId":"user","prompt":"original"})
        );
        let mut image_only = state.clone();
        let image_input = json!([{"type":"localImage","path":"image.png"}]);
        image_only["turns"][0]["params"]["input"] = image_input.clone();
        image_only["turns"][0]["items"][0]["content"] = image_input;
        assert_eq!(editable_turn(&image_only).unwrap()["prompt"], "");
        let page_body = "修改这段说明\n## My request:\n正文中的标题";
        state["turns"][0]["params"]["input"][0]["text"] = json!(format!(
            "<page-comment-context>\ncomment data\n</page-comment-context>\n## My request:\n{page_body}"
        ));
        let page_edit = editable_turn(&state).unwrap();
        assert_eq!(page_edit["prompt"], page_body);
        assert!(page_edit["blockedReason"].is_null());
        state["turns"][0]["status"] = json!("inProgress");
        assert!(editable_turn(&state).is_none());
        state["turns"][0]["status"] = json!("completed");
        state["turns"].as_array_mut().unwrap().push(json!({"id":"synthetic","status":"completed","params":{"input":[{"type":"text","text":"tool forwarded"}]},
            "items":[{"id":"tool-input","type":"functionCallOutput","namespace":"codex_app","name":"send_message_to_thread","output":"<input>tool forwarded</input>"}]}));
        assert!(editable_turn(&state).is_none());
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
