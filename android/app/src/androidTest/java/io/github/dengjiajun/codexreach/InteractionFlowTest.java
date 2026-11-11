package io.github.dengjiajun.codexreach;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class InteractionFlowTest {
    @Test
    public void handlesRequestsQuestionsSkillsAndEditing() throws Exception {
        String stage = InstrumentationRegistry.getArguments().getString("stage", "approvals");
        if (stage.equals("approvals")) control("interactions-reset");
        if (stage.equals("questions")) control("interaction-questions");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> view = new AtomicReference<>();
            scenario.onActivity(activity -> view.set(activity.getBridge().getWebView()));
            WebView webView = view.get();
            await(webView, "document.querySelector('#chat-view [data-connection-status]').textContent==='已连接'");
            if (stage.equals("approvals")) {
                openInteractionChat(webView);
                verifyApprovals(webView);
            } else if (stage.equals("questions")) {
                verifyQuestionDraftsAndPendingReply(webView);
            } else if (stage.equals("question-persist")) {
                verifyReplyPersistenceAndSelectSkill(webView);
            } else {
                assertEquals("skills-edit", stage);
                verifySkillPersistenceAndEdit(webView);
            }
            InstrumentationRegistry.getInstrumentation().getUiAutomation().waitForIdle(500, 10_000);
            File screenshot = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), "verification-interaction-" + stage + ".png");
            try (FileOutputStream output = new FileOutputStream(screenshot)) {
                Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
                assertTrue("Screenshot capture failed", bitmap != null);
                assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
                bitmap.recycle();
            }
        }
    }

    private void openInteractionChat(WebView webView) throws Exception {
        evaluate(webView, "document.querySelector('#back-button').click(); null");
        await(webView, "!document.querySelector('#inbox-view').hidden && !document.querySelector('#refresh-button').disabled && Boolean(document.querySelector('[data-thread-id=\"fixture-interactions\"]'))");
        evaluate(webView, "document.querySelector('[data-thread-id=\"fixture-interactions\"]').click(); null");
        await(webView, "document.querySelector('#chat-title').textContent==='审批与问答验证' && document.querySelector('#messages').textContent.includes('INTERACTION_USER')");
    }

    private void verifyApprovals(WebView webView) throws Exception {
        String command = requestCard(47);
        String file = requestCard("47");
        await(webView, "Boolean(" + command + ") && Boolean(" + file + ")");
        assertEquals("true", evaluate(webView, command + "!==" + file));
        assertEquals("true", evaluate(webView, file + ".textContent.includes('before') && " + file + ".textContent.includes('after')"));
        assertEquals("false", evaluate(webView, "document.querySelector('#requests').textContent.includes('COMPLETED_REQUEST_MUST_HIDE')"));
        for (String requestId : new String[] {"unsupported-form", "verification", "file-incomplete"}) {
            String card = requestCard(requestId);
            assertEquals("true", evaluate(webView, "Boolean(" + card + ".querySelector('.request-desktop')) && " + card + ".querySelectorAll('.request-fields button').length===0"));
        }

        clickActionTwice(webView, command, "允许并保存命令规则");
        awaitCount("responses", 1);
        await(webView, command + ".querySelector('.request-status').textContent.includes('已提交')");
        assertEquals("true", evaluate(webView, command + ".querySelector('.request-fields').disabled"));
        control("interaction-pulse");
        await(webView, "document.querySelector('#messages').textContent.includes('INTERACTION_PULSE_1')");
        clickActionTwice(webView, command, "允许并保存命令规则");
        assertEquals(1, stats().getJSONObject("postCounts").getInt("respond"));
        JSONObject commandResponse = stats().getJSONArray("responses").getJSONObject(0);
        assertTrue(commandResponse.get("approvalRequestId") instanceof Number);
        assertEquals(47, commandResponse.getInt("approvalRequestId"));
        assertEquals("fixture-tool", commandResponse.getJSONObject("response").getJSONObject("decision")
            .getJSONObject("acceptWithExecpolicyAmendment").getJSONArray("execpolicy_amendment").getString(0));
        control("resolve-response");
        await(webView, "!Boolean(" + command + ") && Boolean(" + file + ") && !" + file + ".querySelector('.request-fields').disabled");

        submitAndResolve(webView, "47", "本会话允许", 2);
        JSONObject fileResponse = stats().getJSONArray("responses").getJSONObject(1);
        assertTrue(fileResponse.get("approvalRequestId") instanceof String);
        assertEquals("47", fileResponse.getString("approvalRequestId"));
        assertEquals("acceptForSession", fileResponse.getJSONObject("response").getString("decision"));

        submitAndResolve(webView, "network-rule", "拒绝并保存网络规则", 3);
        JSONObject network = stats().getJSONArray("responses").getJSONObject(2).getJSONObject("response")
            .getJSONObject("decision").getJSONObject("applyNetworkPolicyAmendment").getJSONObject("network_policy_amendment");
        assertEquals("fixture.invalid", network.getString("host"));
        assertEquals("deny", network.getString("action"));

        submitAndResolve(webView, "permission", "仅本轮允许", 4);
        JSONObject permission = stats().getJSONArray("responses").getJSONObject(3).getJSONObject("response");
        assertEquals("turn", permission.getString("scope"));
        assertTrue(permission.getJSONObject("permissions").getJSONObject("network").getBoolean("enabled"));
        JSONObject fileSystem = permission.getJSONObject("permissions").getJSONObject("fileSystem");
        assertEquals("C:\\Example\\input", fileSystem.getJSONArray("read").getString(0));
        assertTrue(fileSystem.isNull("write"));
        assertEquals(3, fileSystem.getInt("globScanMaxDepth"));
        assertEquals("deny", fileSystem.getJSONArray("entries").getJSONObject(1).getString("access"));
        assertEquals("glob_pattern", fileSystem.getJSONArray("entries").getJSONObject(1).getJSONObject("path").getString("type"));

        String form = requestCard("mcp-form");
        evaluate(webView, "(()=>{const fields=" + form + ".querySelectorAll('.request-field'); fields[1].querySelector('input').value='2'; fields[2].querySelector('select').value='true'; fields[3].querySelector('select').value='1'; for(const option of fields[4].querySelector('select').options) option.selected=true; " + form + ".querySelector('form').requestSubmit(); return null})()");
        assertEquals(4, stats().getJSONArray("responses").length());
        evaluate(webView, "(()=>{const input=" + form + ".querySelector('.request-field input'); input.value='协议核对'; input.dispatchEvent(new Event('input',{bubbles:true})); " + form + ".querySelector('form').requestSubmit(); " + form + ".querySelector('form').requestSubmit(); return null})()");
        awaitCount("responses", 5);
        JSONObject formResponse = stats().getJSONArray("responses").getJSONObject(4).getJSONObject("response");
        assertEquals("accept", formResponse.getString("action"));
        assertTrue(formResponse.isNull("_meta"));
        JSONObject content = formResponse.getJSONObject("content");
        assertEquals("协议核对", content.getString("name"));
        assertTrue(content.get("count") instanceof Number);
        assertEquals(2, content.getInt("count"));
        assertTrue(content.get("confirmed") instanceof Boolean);
        assertTrue(content.getBoolean("confirmed"));
        assertEquals("fast", content.getString("mode"));
        assertEquals("logs", content.getJSONArray("features").getString(0));
        assertEquals("summary", content.getJSONArray("features").getString(1));
        assertFalse(content.has("note"));
        control("resolve-response");
        await(webView, "!Boolean(" + form + ")");

        String url = requestCard(48);
        await(webView, "!" + url + ".querySelector('.request-fields').disabled");
        assertEquals("true", evaluate(webView, button(url, "已完成，继续") + ".disabled"));
        evaluate(webView, "(()=>{const link=" + url + ".querySelector('a'); link.addEventListener('click',event=>event.preventDefault(),{once:true}); link.click(); return null})()");
        assertEquals("false", evaluate(webView, button(url, "已完成，继续") + ".disabled"));
        submitAndResolve(webView, 48, "已完成，继续", 6);
        JSONObject urlResponse = stats().getJSONArray("responses").getJSONObject(5).getJSONObject("response");
        assertEquals("accept", urlResponse.getString("action"));
        assertEquals(0, urlResponse.getJSONObject("content").length());
        assertTrue(urlResponse.isNull("_meta"));
        assertEquals(6, stats().getJSONObject("postCounts").getInt("respond"));
    }

    private void verifyQuestionDraftsAndPendingReply(WebView webView) throws Exception {
        String sync = requestCard("sync-input");
        await(webView, "Boolean(" + sync + ") && document.querySelectorAll('.async-questions .request-card').length===2");
        setComposer(webView, "保留的普通草稿");
        evaluate(webView, "(()=>{const groups=" + sync + ".querySelectorAll('.request-question'); groups[0].querySelector('input[type=radio]').click(); window.fixtureQuestionDraft=groups[1].querySelector('textarea'); window.fixtureQuestionDraft.value='SYNC_DRAFT_RETAINED'; window.fixtureQuestionDraft.dispatchEvent(new Event('input',{bubbles:true})); window.fixtureQuestionDraft.focus(); return null})()");
        control("interaction-pulse");
        await(webView, "document.querySelector('#messages').textContent.includes('INTERACTION_PULSE_2')");
        assertEquals("true", evaluate(webView, sync + ".querySelectorAll('.request-question')[1].querySelector('textarea')===window.fixtureQuestionDraft && window.fixtureQuestionDraft.value==='SYNC_DRAFT_RETAINED' && document.activeElement===window.fixtureQuestionDraft"));
        assertEquals("true", evaluate(webView, sync + ".querySelector('input[type=radio]').checked"));
        evaluate(webView, sync + ".querySelector('form').requestSubmit(); " + sync + ".querySelector('form').requestSubmit(); null");
        awaitCount("responses", 7);
        JSONObject answers = stats().getJSONArray("responses").getJSONObject(6).getJSONObject("response").getJSONObject("answers");
        assertEquals("检查", answers.getJSONObject("choice").getJSONArray("answers").getString(0));
        assertEquals("SYNC_DRAFT_RETAINED", answers.getJSONObject("detail").getJSONArray("answers").getString(0));
        control("resolve-response");
        await(webView, "!Boolean(" + sync + ") && !" + asyncCard(0) + ".querySelector('.request-fields').disabled");

        evaluate(webView, asyncCard(0) + ".querySelector('input[type=radio]').click(); " + asyncCard(0) + ".querySelector('form').requestSubmit(); " + asyncCard(0) + ".querySelector('form').requestSubmit(); null");
        awaitCount("messageRequests", 1);
        await(webView, "!document.querySelector('#delivery-note').hidden && " + asyncCard(0) + ".querySelector('.request-fields').disabled");
        assertEquals("true", evaluate(webView, asyncCard(0) + ".querySelector('input[type=radio]').checked && " + asyncCard(0) + ".querySelectorAll('input[type=radio]:checked').length===1"));
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的普通草稿'"));
        JSONObject first = questionReply(stats().getJSONArray("messageRequests").getJSONObject(0));
        assertEquals("[\"request_user_input_async\",\"async-question-item\",0]", first.getString("questionItemId"));
        assertEquals("选择下一步", first.getString("question"));
        assertEquals("检查", first.getString("answer"));
        assertEquals(1, stats().getJSONObject("postCounts").getInt("messages"));
        SystemClock.sleep(800);
    }

    private void verifyReplyPersistenceAndSelectSkill(WebView webView) throws Exception {
        await(webView, "document.querySelector('#chat-title').textContent==='审批与问答验证' && !document.querySelector('#delivery-note').hidden && Boolean(" + asyncCard(0) + ")");
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的普通草稿' && " + asyncCard(0) + ".querySelector('.request-fields').disabled"));
        assertEquals("true", evaluate(webView, asyncCard(0) + ".querySelector('input[type=radio]').checked && " + asyncCard(0) + ".querySelectorAll('input[type=radio]:checked').length===1"));
        assertEquals(1, stats().getJSONArray("messageRequests").length());
        assertEquals(1, stats().getJSONObject("postCounts").getInt("messages"));
        control("release-message");
        await(webView, "document.querySelector('#delivery-note').hidden && " + asyncCard(0) + ".querySelector('.request-answer')?.textContent.includes('检查')");
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的普通草稿'"));

        evaluate(webView, asyncCard(1) + ".querySelector('textarea').value='ASYNC_FREE_TEXT'; " + asyncCard(1) + ".querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true})); " + asyncCard(1) + ".querySelector('form').requestSubmit(); null");
        awaitCount("messageRequests", 2);
        JSONObject second = questionReply(stats().getJSONArray("messageRequests").getJSONObject(1));
        assertEquals("[\"request_user_input_async\",\"async-question-item\",1]", second.getString("questionItemId"));
        assertEquals("填写后续说明", second.getString("question"));
        assertEquals("ASYNC_FREE_TEXT", second.getString("answer"));
        await(webView, "!document.querySelector('#delivery-note').hidden && " + asyncCard(1) + ".querySelector('.request-fields').disabled");
        assertEquals("true", evaluate(webView, asyncCard(1) + ".querySelector('textarea').value==='ASYNC_FREE_TEXT'"));
        control("message-unknown");
        await(webView, "!document.querySelector('#resolve-delivery').hidden");
        assertEquals("true", evaluate(webView, asyncCard(1) + ".querySelector('textarea').value==='ASYNC_FREE_TEXT' && document.querySelector('#message-input').value==='保留的普通草稿'"));
        evaluate(webView, "document.querySelector('#resolve-delivery').click(); null");
        await(webView, "document.querySelector('#delivery-note').hidden && !" + asyncCard(1) + ".querySelector('.request-fields').disabled");
        assertEquals("true", evaluate(webView, asyncCard(1) + ".querySelector('textarea').value==='ASYNC_FREE_TEXT' && !" + asyncCard(1) + ".querySelector('textarea').matches(':disabled')"));
        control("interaction-pulse");
        await(webView, "document.querySelector('#messages').textContent.includes('INTERACTION_PULSE_3')");
        assertEquals("true", evaluate(webView, asyncCard(1) + ".querySelector('textarea').value==='ASYNC_FREE_TEXT' && document.querySelector('#message-input').value==='保留的普通草稿'"));
        assertEquals(2, stats().getJSONObject("postCounts").getInt("messages"));
        control("release-message");
        await(webView, "document.querySelector('#delivery-note').hidden && document.querySelectorAll('.async-questions .request-answer').length===2");
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='保留的普通草稿' && !document.querySelector('#messages').textContent.includes('<send_user_message_question_reply>')"));

        evaluate(webView, "document.querySelector('#skills-button').click(); null");
        await(webView, "document.querySelector('#skills-dialog').open && !document.querySelector('#save-skills').disabled && !document.querySelector('#open-skill-chat').hidden");
        evaluate(webView, "document.querySelector('#open-skill-chat').click(); null");
        await(webView, "document.querySelector('#open-skill-chat').hidden && document.querySelector('#skills-status').textContent.includes('已在电脑端打开')");
        assertEquals(1, stats().getInt("openCount"));
        evaluate(webView, "document.querySelector('#skills-search').value='精确协议'; document.querySelector('#skills-search').dispatchEvent(new Event('input',{bubbles:true})); null");
        assertEquals("true", evaluate(webView, "document.querySelectorAll('#skills-list .skill-choice').length===1 && document.querySelector('#skills-list').textContent.includes('interaction-check')"));
        evaluate(webView, "document.querySelector('#skills-list input[type=checkbox]').click(); document.querySelector('#skills-form').requestSubmit(); null");
        await(webView, "!document.querySelector('#skills-dialog').open && document.querySelector('#selected-skills').textContent.includes('interaction-check')");
        setComposer(webView, "SKILL_SEND_CHECK");
        SystemClock.sleep(800);
    }

    private void verifySkillPersistenceAndEdit(WebView webView) throws Exception {
        await(webView, "document.querySelector('#chat-title').textContent==='审批与问答验证' && document.querySelector('#selected-skills').textContent.includes('interaction-check') && document.querySelectorAll('.async-questions .request-answer').length===2");
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='SKILL_SEND_CHECK'"));
        evaluate(webView, "document.querySelector('#message-form').requestSubmit(); document.querySelector('#message-form').requestSubmit(); null");
        awaitCount("messageRequests", 3);
        JSONObject send = stats().getJSONArray("messageRequests").getJSONObject(2);
        assertEquals("SKILL_SEND_CHECK", send.getString("prompt"));
        assertEquals(1, send.getJSONArray("skills").length());
        assertEquals("interaction-check", send.getJSONArray("skills").getJSONObject(0).getString("name"));
        assertEquals("C:\\Skills\\interaction-check\\SKILL.md", send.getJSONArray("skills").getJSONObject(0).getString("path"));
        setComposer(webView, "编辑和发送期间保留的新草稿");
        control("release-message");
        await(webView, "document.querySelector('#delivery-note').hidden && document.querySelector('#messages').textContent.includes('SKILL_PRE_EDIT_REPLY') && document.querySelector('#selected-skills').hidden");
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='编辑和发送期间保留的新草稿'"));
        assertEquals(3, stats().getJSONObject("postCounts").getInt("messages"));
        await(webView, "[...document.querySelectorAll('.edit-message')].filter(button=>!button.hidden&&!button.disabled).length===1");
        evaluate(webView, "[...document.querySelectorAll('.edit-message')].find(button=>!button.hidden).click(); null");
        await(webView, "document.querySelector('#edit-dialog').open");
        assertEquals("true", evaluate(webView, "document.querySelector('#edit-prompt').value==='SKILL_SEND_CHECK'"));
        evaluate(webView, "document.querySelector('#edit-prompt').value='EDITED_USER_CHECK'; document.querySelector('#edit-prompt').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-close-dialog=\"edit-dialog\"]').click(); null");
        evaluate(webView, "[...document.querySelectorAll('.edit-message')].find(button=>!button.hidden).click(); null");
        await(webView, "document.querySelector('#edit-dialog').open");
        assertEquals("true", evaluate(webView, "document.querySelector('#edit-prompt').value==='EDITED_USER_CHECK'"));
        evaluate(webView, "document.querySelector('#edit-form').requestSubmit(); document.querySelector('#edit-form').requestSubmit(); null");
        awaitCount("editRequests", 1);
        await(webView, "!document.querySelector('#interaction-note').hidden");
        JSONObject edit = stats().getJSONArray("editRequests").getJSONObject(0);
        assertEquals("interaction-message-" + send.getString("requestId"), edit.getString("turnId"));
        assertEquals("EDITED_USER_CHECK", edit.getString("prompt"));
        assertEquals("true", evaluate(webView, "document.querySelector('#message-input').value==='编辑和发送期间保留的新草稿'"));
        control("release-edit");
        await(webView, "document.querySelector('#interaction-note').hidden && document.querySelector('#messages').textContent.includes('EDIT_REPLACED_REPLY') && document.querySelector('#messages').textContent.includes('EDITED_USER_CHECK')");
        assertEquals("true", evaluate(webView, "!document.querySelector('#messages').textContent.includes('SKILL_PRE_EDIT_REPLY') && !document.querySelector('#messages').textContent.includes('SKILL_SEND_CHECK') && document.querySelector('#message-input').value==='编辑和发送期间保留的新草稿'"));
        assertEquals(1, stats().getJSONObject("postCounts").getInt("edit"));
    }

    private JSONObject questionReply(JSONObject request) throws Exception {
        String prompt = request.getString("prompt");
        assertTrue(prompt.startsWith("<send_user_message_question_reply>\n"));
        assertTrue(prompt.endsWith("\n</send_user_message_question_reply>"));
        JSONArray replies = new JSONArray(prompt.substring(prompt.indexOf('\n') + 1, prompt.lastIndexOf('\n')));
        assertEquals(1, replies.length());
        return replies.getJSONObject(0);
    }

    private void submitAndResolve(WebView webView, Object requestId, String label, int count) throws Exception {
        String card = requestCard(requestId);
        await(webView, "Boolean(" + card + ") && !" + card + ".querySelector('.request-fields').disabled");
        clickActionTwice(webView, card, label);
        awaitCount("responses", count);
        await(webView, card + ".querySelector('.request-status').textContent.includes('已提交')");
        control("resolve-response");
        await(webView, "!Boolean(" + card + ")");
    }

    private void clickActionTwice(WebView webView, String card, String label) throws Exception {
        evaluate(webView, "(()=>{const action=" + button(card, label) + "; action.click(); action.click(); return null})()");
    }

    private String requestCard(Object id) throws Exception {
        String jsonId = id instanceof String ? JSONObject.quote((String) id) : String.valueOf(id);
        return "([...document.querySelectorAll('#requests .request-card')].find(card=>card.dataset.requestId===JSON.stringify(" + jsonId + ")))";
    }

    private String asyncCard(int index) {
        return "document.querySelectorAll('[data-message-id=\"async-question-item\"] .async-questions .request-card')[" + index + "]";
    }

    private String button(String card, String label) {
        return "([..." + card + ".querySelectorAll('button')].find(button=>button.textContent===" + JSONObject.quote(label) + "))";
    }

    private void setComposer(WebView webView, String text) throws Exception {
        evaluate(webView, "document.querySelector('#message-input').value=" + JSONObject.quote(text) + "; document.querySelector('#message-input').dispatchEvent(new Event('input',{bubbles:true})); null");
    }

    private void control(String name) throws Exception {
        request("/control/" + name, "POST");
    }

    private JSONObject stats() throws Exception {
        return new JSONObject(request("/control/interaction-stats", "GET"));
    }

    private String request(String path, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create("http://10.0.2.2:4320" + path).toURL().openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            assertEquals(200, connection.getResponseCode());
            return new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private void awaitCount(String name, int expected) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 20_000;
        while (stats().getJSONArray(name).length() != expected) {
            assertTrue("Timed out waiting for fixture list " + name, SystemClock.elapsedRealtime() < deadline);
            SystemClock.sleep(100);
        }
    }

    private void await(WebView webView, String condition) throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 30_000;
        while (!evaluate(webView, "Boolean(" + condition + ")").equals("true")) {
            assertTrue("Timed out waiting for " + condition, SystemClock.elapsedRealtime() < deadline);
            SystemClock.sleep(200);
        }
    }

    private String evaluate(WebView webView, String script) throws InterruptedException {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            webView.evaluateJavascript(script, result -> {
                value.set(result);
                completed.countDown();
            })
        );
        assertTrue("WebView evaluation timed out", completed.await(10, TimeUnit.SECONDS));
        return value.get();
    }
}
