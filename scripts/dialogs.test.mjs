import assert from 'node:assert/strict';
import test from 'node:test';
import { closeTopDialog, showDialog } from '../src/ui.ts';

class Dialog extends EventTarget {
  open = false;
  isConnected = true;
  querySelector() { return null; }
  showModal() { this.open = true; }
  close() {
    this.open = false;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
}

test('back closes dialogs in opening order even when DOM order differs', async () => {
  const addContent = new Dialog();
  const newChat = new Dialog();
  showDialog(newChat);
  showDialog(addContent);
  showDialog(newChat); // Showing an already open lower dialog does not raise it.
  assert.equal(closeTopDialog(), true);
  assert.equal(addContent.open, false);
  assert.equal(newChat.open, true);
  assert.equal(closeTopDialog(), true);
  assert.equal(newChat.open, false);
  assert.equal(closeTopDialog(), false);
  await Promise.resolve();
});

test('closing and reopening before the close event retains the reopened top dialog', async () => {
  const lower = new Dialog();
  const upper = new Dialog();
  showDialog(lower);
  showDialog(upper);
  upper.close();
  showDialog(upper);
  await Promise.resolve();
  assert.equal(closeTopDialog(), true);
  assert.equal(upper.open, false);
  assert.equal(lower.open, true);
  lower.close();
  await Promise.resolve();
  assert.equal(closeTopDialog(), false);
});
