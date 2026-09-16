const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('personal Messenger sends are serialized and image work is not detached by a timeout race', () => {
  const source = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(source, /const personalSendChains = new Map\(\)/);
  assert.match(source, /runPersonalSendSerialized\([\s\S]+?\(\) => handleSendMessage\(\{/);
  assert.doesNotMatch(source, /PERSONAL_SEND_HANDLER_TIMEOUT/);
});

test('personal images prefer the mounted composer file input before chooser interception', () => {
  const source = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(source, /preferDirectInput: preferredKind !== 'video'/);
  assert.match(source, /Runtime\.evaluate/);
  assert.match(source, /DOM\.setFileInputFiles/);
  assert.match(source, /visibleComposerControl/);
  assert.match(source, /newestFirst\.find/);
  assert.match(source, /const preferredKind = items\.some/);
  assert.match(source, /findAttachButtonCenter\(tabId, 6000, preferredKind\)/);
  assert.match(source, /selectAttachmentCapableMessengerTab/);
});
test('failed media draft is isolated before both text and attachment sends', () => {
  const source = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(source, /async function isolateFailedMediaDraftBeforeSend\(tabId\)/);
  assert.match(source, /dirtyAttachmentDraftTabs\.add\(tab\.id\);[\s\S]+?await resetFailedMessengerComposerDraft\(tab\.id\)/);
  assert.equal((source.match(/await isolateFailedMediaDraftBeforeSend\(tab\.id\);/g) || []).length, 2);
});

test('composer-dispatched text is persisted as sent before the ACK watchdog can fail it', () => {
  const source = fs.readFileSync('src/server/server.js', 'utf8');
  const dispatchedBranch = source.slice(source.indexOf("error_code === 'COMPOSER_DISPATCHED'"), source.indexOf("case 'CONTENT_DEBUG'"));
  assert.match(dispatchedBranch, /UPDATE messages SET delivery_status = 'sent', delivery_error = NULL/);
  assert.match(dispatchedBranch, /attachment_id IS NULL/);
  assert.match(dispatchedBranch, /media_type IS NULL OR media_type = 'text'/);
  assert.match(dispatchedBranch, /updateQueueStatusFromClientMessage\(client_message_id, 'sent'\)/);
});

test('personal video submission is not poisoned by videos already present in conversation history', () => {
  const source = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.doesNotMatch(source, /querySelectorAll\('img\[src\^="blob:"\], video, \[aria-label\*=/);
  assert.match(source, /const explicitInput = newestFirst\.find/);
  assert.match(source, /const matchingInput = explicitInput \|\| genericInput/);
  assert.match(source, /desiredKind === 'file' \? newestFirst\[0\] : null/);
  assert.match(source, /readyStreak >= \(hasVideo \? 2 : 1\)/);
  assert.match(source, /const stagedVideoInput = expectVideo/);
  assert.match(source, /ready: \(Boolean\(sendButton\) \|\| stagedVideoInput\) && busy === 0/);
  assert.doesNotMatch(source, /ready: Boolean\(sendButton\) && busy === 0 && uploadLabels === 0/);
  assert.match(source, /cdpResult = await dispatchTrustedEnter\(tabId\)/);
  assert.match(source, /throw error;[\s\S]+?async function handleSendMessage/);
});

test('a later hydrated observation enriches an existing incoming video row', () => {
  const serverSource = fs.readFileSync('src/server/server.js', 'utf8');
  const contentSource = fs.readFileSync('src/extension/content.js', 'utf8');
  const bubbleSource = fs.readFileSync('src/client/components/MessageBubble.jsx', 'utf8');
  const viewerSource = fs.readFileSync('src/client/components/MediaViewer.jsx', 'utf8');
  assert.match(contentSource, /domObservationSignature[\s\S]+?parsed\?\.media_url/);
  assert.doesNotMatch(contentSource, /performance\.getEntriesByType\('resource'\)/);
  assert.match(contentSource, /Only row-scoped sources\/posters are safe here/);
  assert.match(serverSource, /let mediaWasUpdated = false/);
  assert.match(serverSource, /media_url = COALESCE\(NULLIF\(\?, ''\), media_url\)/);
  assert.match(serverSource, /!directionWasUpdated && !mediaWasUpdated/);
  assert.match(bubbleSource, /hasRenderableMedia/);
  assert.doesNotMatch(viewerSource, /Video đang đồng bộ/);
});

test('url-less video hydration stays silent or shows syncing indicator until the real media URL is available', () => {
  const viewerSource = fs.readFileSync('src/client/components/MediaViewer.jsx', 'utf8');
  assert.match(viewerSource, /if \(!displayUrl\)/);
  assert.match(viewerSource, /Đang đồng bộ video\.\.\./);
});

test('campaign personal sends use durable external thread identity and fail closed on contact mismatch', () => {
  const source = fs.readFileSync('src/extension/background.js', 'utf8');
  const worker = fs.readFileSync('src/server/services/QueueWorker.js', 'utf8');
  const repository = fs.readFileSync('src/server/repositories/MessageQueueRepository.js', 'utf8');
  assert.match(repository, /t\.external_thread_id AS recipient_thread_id/);
  assert.match(worker, /recipient_thread_id: message\.recipient_thread_id \|\| null/);
  assert.match(source, /recipient_thread_id: data\.recipient_thread_id \|\| null/);
  assert.match(source, /strict_recipient_identity: Boolean\(data\.campaign_id\)/);
  assert.match(source, /CAMPAIGN_RECIPIENT_IDENTITY_MISMATCH/);
  assert.match(source, /assertCampaignRecipientIdentity\(expected_contact_name, visibleContactName, strict_recipient_identity/);
  assert.match(source, /if \(strict_recipient_identity\) throw err/);
});
test('campaign recipient composer is thread-bound even when selected contacts share the same name', () => {
  const source = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(source, /async function prepareCampaignRecipientComposer\(tabId, targetThreadId/);
  assert.match(source, /forceCleanViewport: strict_recipient_identity/);
  assert.equal((source.match(/forceCleanViewport: strict_recipient_identity/g) || []).length, 2);
  assert.match(source, /stable_polls: 1/);
  assert.match(source, /data-crm-campaign-recipient-thread/);
  assert.match(source, /Campaign route changed before text insert/);
  assert.match(source, /React may replace the verified composer node between polls/);
  assert.match(source, /const box = boundBox \|\| freshCampaignBox/);
  assert.match(source, /stage: 'campaign_recipient_composer_timeout'/);
  assert.match(source, /if \(strict_recipient_identity\) await confirmFromRenderedBubble/);
});
test('a trusted attachment click is a single submit and history retains url-less media confirmations', () => {
  const extensionSource = fs.readFileSync('src/extension/background.js', 'utf8');
  const serverSource = fs.readFileSync('src/server/server.js', 'utf8');
  const branchStart = extensionSource.indexOf('if (hasValidCenter)');
  const trustedClickBranch = extensionSource.slice(branchStart, extensionSource.indexOf('} else {', branchStart));
  assert.match(trustedClickBranch, /trusted_send_single_dispatch/);
  assert.doesNotMatch(trustedClickBranch, /dispatchTrustedEnter/);
  assert.match(serverSource, /m\.media_type && m\.media_type !== 'text'/);
  assert.match(serverSource, /BACKEND_HISTORY_MEDIA_ECHO_COLLAPSED/);
});
test('composer media confirmation uses the existing outbound correlation path', () => {
  const serverSource = fs.readFileSync('src/server/server.js', 'utf8');
  assert.match(serverSource, /const isTrustedOutgoingObservation =[\s\S]+?m\.source === 'composer_confirmation'/);
  assert.match(serverSource, /isOutgoing && isTrustedOutgoingObservation &&/);
  assert.match(serverSource, /if \(isTrustedOutgoingObservation && isOutgoing\)/);
});

test('message_queue migration accepts image/video/file and failed cleanup does not poison the next send', () => {
  const migrationSource = fs.readFileSync('src/server/database/db.js', 'utf8');
  const extensionSource = fs.readFileSync('src/extension/background.js', 'utf8');
  assert.match(migrationSource, /version: 59,[\s\S]+?attachment_media_type TEXT CHECK\(attachment_media_type IN \('image', 'video', 'file'\)\)/);
  assert.match(extensionSource, /if \(resetResult\?\.success\) dirtyAttachmentDraftTabs\.delete\(tab\.id\)/);
});

test('hydrated outgoing video confirms pending state without replaying anonymous history or calls', () => {
  const source = fs.readFileSync('src/extension/content.js', 'utf8');
  const reconcileStart = source.indexOf('function reconcileLatestIncomingMessages()');
  const reconcileEnd = source.indexOf('// Initialize everything', reconcileStart);
  const reconcile = source.slice(reconcileStart, reconcileEnd);
  assert.match(reconcile, /if \(!parsed\.native_id\) continue;/);
  assert.match(reconcile, /const isMediaRow = Boolean/);
  assert.match(reconcile, /if \(parsed\.is_outgoing && !isCallRow && !isMediaRow\) continue;/);
  assert.doesNotMatch(source, /callLogObserver\.observe\(document\.body/);
});
