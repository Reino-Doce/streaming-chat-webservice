const http = require("http");
const { randomUUID } = require("crypto");

const PROTOCOL_ID = "uscp-sse/1";
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_MAX_IDLE_MS = 60000;
const SESSION_TTL_MS = 60 * 60 * 1000;

const SOURCE_DICTIONARY = Object.freeze([
  [1, "stream"],
  [2, "runtime"],
  [3, "tiktok"],
  [4, "mock"],
]);

const CANONICAL_TYPE_CODES = Object.freeze([
  "chat.message",
  "monetization.donation.gift",
  "interaction.reaction.like",
  "interaction.reaction.share",
  "audience.followage.updated",
  "moderation.message.delete",
  "moderation.message.pin",
  "moderation.message.unpin",
  "monetization.subscription.superfan",
  "audience.member.entered",
  "audience.room.presence.updated",
  "interaction.social.activity",
  "chat.question.created",
  "competition.link_mic_battle.started",
  "competition.link_mic_battle.points.updated",
  "competition.link_mic_battle.punishment.finished",
  "competition.link_mic_battle.task.updated",
  "stream.intro.updated",
  "chat.emote.reaction",
  "monetization.envelope.updated",
  "stream.lifecycle.ended",
  "stream.control.updated",
  "audience.room_join",
  "audience.rank.hourly.updated",
  "stream.goal.progress.updated",
  "stream.notice.announced",
  "stream.caption.segment.published",
  "stream.banner.in_room.updated",
  "audience.rank.updated",
  "interaction.poll.updated",
  "audience.rank.text.updated",
  "audience.fan_club.fan_level",
  "competition.link_mic.session.updated",
  "moderation.member.unauthorized",
  "commerce.live.shopping.updated",
  "diagnostics.message.detected",
  "competition.link.message.updated",
  "stream.room.verification.updated",
  "competition.link.layer.updated",
  "system.upstream.event",
  "upstream.social_stream.event",
]);

const TYPE_DICTIONARY = Object.freeze(
  CANONICAL_TYPE_CODES.map((typeCode, index) => [index + 1, typeCode]),
);

const SOURCE_FIELD_KEYS = Object.freeze([
  "source_message_id",
  "source_room_id",
  "source_create_time",
]);

const KNOWN_USER_CODE_FIELDS = Object.freeze([
  "user_id",
  "from_user_id",
  "operator_user_id",
  "invite_uid",
  "cur_user_id",
  "linker_id",
  "top_user_id",
  "leave_user_id",
  "kickout_user_id",
  "barrage_user_id",
]);

const KNOWN_USER_CODE_ARRAY_FIELDS = Object.freeze([
  "participant_user_ids",
]);

const MAX_KNOWN_USERS = 5000;

function withSourceFields(fields = []) {
  return new Set([...SOURCE_FIELD_KEYS, ...fields]);
}

const TYPE_PAYLOAD_RULES = Object.freeze({
  "chat.message": {
    required: ["message_text"],
    allowed: withSourceFields([
      "message_text",
      "message_language",
      "replies_to",
      "user_displayname",
      "user_badges",
      "user_role",
      "send_time",
      "user_image_id",
      "user_color",
    ]),
  },
  "monetization.donation.gift": {
    required: ["gift_id"],
    allowed: withSourceFields([
      "donation_value",
      "donation_amount",
      "donation_currency",
      "donation_value_minor",
      "donation_value_usd",
      "gift_id",
      "gift_amount",
      "gift_value",
      "combo_count",
      "gift_diamond_count",
      "gift_description",
      "user_displayname",
      "user_badges",
      "user_role",
      "send_time",
      "user_image_id",
      "user_color",
    ]),
  },
  "interaction.reaction.like": {
    required: ["reaction_type"],
    allowed: withSourceFields([
      "reaction_type",
      "reaction_amount",
      "total_like_count",
      "display_pattern",
      "user_displayname",
      "user_image_id",
    ]),
  },
  "interaction.reaction.share": {
    required: ["reaction_type"],
    allowed: withSourceFields([
      "reaction_type",
      "reaction_amount",
      "action",
      "share_type",
      "share_count",
      "follow_count",
      "display_pattern",
      "user_displayname",
      "user_image_id",
    ]),
  },
  "audience.followage.updated": {
    required: ["followage_type"],
    allowed: withSourceFields([
      "followage_type",
      "action",
      "share_type",
      "follow_count",
      "share_count",
      "display_pattern",
      "user_displayname",
      "user_image_id",
    ]),
  },
  "moderation.message.delete": {
    required: ["message_id"],
    allowed: withSourceFields(["message_id", "user_displayname"]),
  },
  "moderation.message.pin": {
    required: ["message_id", "sticky_length"],
    allowed: withSourceFields(["message_id", "sticky_length", "user_displayname"]),
  },
  "moderation.message.unpin": {
    required: ["message_id"],
    allowed: withSourceFields(["message_id", "user_displayname"]),
  },
  "monetization.subscription.superfan": {
    required: ["subscription_type"],
    allowed: withSourceFields(["subscription_type", "message_text", "user_displayname"]),
  },
  "audience.member.entered": {
    required: [],
    allowed: withSourceFields([
      "action",
      "member_count",
      "enter_type",
      "display_style",
      "user_id",
      "pop_text",
      "action_description",
      "display_pattern",
      "user_displayname",
      "user_image_id",
    ]),
  },
  "audience.room.presence.updated": {
    required: [],
    allowed: withSourceFields(["viewer_count", "total_user", "popularity", "anonymous", "anonymous_count"]),
  },
  "interaction.social.activity": {
    required: [],
    allowed: withSourceFields([
      "social_action",
      "share_type",
      "share_target",
      "follow_count",
      "share_count",
      "display_pattern",
      "user_displayname",
      "user_image_id",
    ]),
  },
  "chat.question.created": {
    required: [],
    allowed: withSourceFields(["question_text", "question_id"]),
  },
  "competition.link_mic_battle.started": {
    required: ["battle_id", "battle_action"],
    allowed: withSourceFields([
      "battle_id",
      "battle_action",
      "channel_id",
      "participant_user_ids",
      "invitee_gift_permission_type",
      "bubble_text",
    ]),
  },
  "competition.link_mic_battle.points.updated": {
    required: ["battle_id", "battle_status"],
    allowed: withSourceFields([
      "battle_id",
      "battle_status",
      "channel_id",
      "from_user_id",
      "gift_id",
      "gift_count",
      "total_diamond_count",
      "repeat_count",
      "battle_start_time_ms",
      "battle_end_time_ms",
      "trigger_critical_strike",
      "battle_items",
    ]),
  },
  "competition.link_mic_battle.punishment.finished": {
    required: ["battle_id", "channel_id"],
    allowed: withSourceFields([
      "battle_id",
      "channel_id",
      "operator_user_id",
      "reason_code",
      "battle_start_time_ms",
      "battle_end_time_ms",
    ]),
  },
  "competition.link_mic_battle.task.updated": {
    required: ["battle_id", "task_message_type"],
    allowed: withSourceFields([
      "battle_id",
      "task_message_type",
      "task_progress",
      "from_user_id",
      "task_result",
      "reward_status",
    ]),
  },
  "stream.intro.updated": {
    required: [],
    allowed: withSourceFields(["intro_mode", "description", "language", "host_user_id", "host_nickname"]),
  },
  "chat.emote.reaction": {
    required: [],
    allowed: withSourceFields(["emote_ids", "emote_count"]),
  },
  "monetization.envelope.updated": {
    required: [],
    allowed: withSourceFields(["envelope_id", "display"]),
  },
  "stream.lifecycle.ended": {
    required: [],
    allowed: withSourceFields(["end_action", "action"]),
  },
  "stream.control.updated": {
    required: [],
    allowed: withSourceFields(["control_action", "action", "tips", "float_text", "float_style", "message_scene"]),
  },
  "audience.room_join": {
    required: [],
    allowed: withSourceFields([
      "action",
      "join_event",
      "msg_type",
      "sub_type",
      "content",
      "duration_ms",
      "scene",
      "barrage_user_id",
      "barrage_user_unique_id",
      "barrage_user_displayname",
      "fan_level_current_grade",
      "user_level_current_grade",
      "level_value",
      "user_displayname",
      "user_image_id",
    ]),
  },
  "audience.rank.hourly.updated": {
    required: [],
    allowed: withSourceFields(["rank_data", "rank_data2"]),
  },
  "stream.goal.progress.updated": {
    required: [],
    allowed: withSourceFields(["goal_id", "contribute_count", "contribute_score", "update_source"]),
  },
  "stream.notice.announced": {
    required: [],
    allowed: withSourceFields([
      "content",
      "display_pattern",
      "source_type",
      "source",
      "scene",
      "is_welcome",
      "show_duration_ms",
    ]),
  },
  "stream.caption.segment.published": {
    required: [],
    allowed: withSourceFields([
      "content",
      "timestamp_ms",
      "duration_ms",
      "sentence_id",
      "sequence_id",
      "definite",
    ]),
  },
  "stream.banner.in_room.updated": {
    required: [],
    allowed: withSourceFields(["banner_state", "json_data"]),
  },
  "audience.rank.updated": {
    required: [],
    allowed: withSourceFields(["group_type", "priority"]),
  },
  "interaction.poll.updated": {
    required: [],
    allowed: withSourceFields(["poll_id", "message_type", "poll_kind"]),
  },
  "audience.rank.text.updated": {
    required: [],
    allowed: withSourceFields([
      "scene",
      "self_badge_pattern",
      "other_badge_pattern",
      "owner_idx_before_update",
      "owner_idx_after_update",
      "cur_user_id",
    ]),
  },
  "audience.fan_club.fan_level": {
    required: [],
    allowed: withSourceFields([
      "fan_level",
      "notice_type",
      "total_link_mic_fan_ticket",
      "top_user_fan_ticket",
      "top_user_id",
      "top_user_nickname",
      "fan_ticket_users",
      "user_displayname",
      "user_image_id",
    ]),
  },
  "competition.link_mic.session.updated": {
    required: [],
    allowed: withSourceFields([
      "message_type",
      "sub_type",
      "channel_id",
      "user_id",
      "invite_uid",
      "duration",
      "match_type",
      "win",
    ]),
  },
  "moderation.member.unauthorized": {
    required: [],
    allowed: withSourceFields(["action", "nickname"]),
  },
  "commerce.live.shopping.updated": {
    required: [],
    allowed: withSourceFields(["shop_data", "detail_count"]),
  },
  "diagnostics.message.detected": {
    required: [],
    allowed: withSourceFields(["detect_type", "trigger_condition", "trigger_by", "from_region"]),
  },
  "competition.link.message.updated": {
    required: [],
    allowed: withSourceFields(["message_type", "scene", "linker_id", "expire_timestamp", "linked_users"]),
  },
  "stream.room.verification.updated": {
    required: [],
    allowed: withSourceFields(["action", "notice_type", "close_room"]),
  },
  "competition.link.layer.updated": {
    required: [],
    allowed: withSourceFields([
      "message_type",
      "channel_id",
      "scene",
      "source_type",
      "source",
      "leave_user_id",
      "leave_reason",
      "kickout_user_id",
      "kickout_reason",
      "cohost_user_infos",
      "business_content",
    ]),
  },
  "system.upstream.event": {
    required: ["upstream", "upstream_event"],
    allowed: withSourceFields(["upstream", "upstream_event", "summary", "state", "reason"]),
  },
  "upstream.social_stream.event": {
    required: ["upstream_event"],
    allowed: new Set(["upstream_event", "summary"]),
  },
});

function asObject(value, fallback = {}) {
  return value && typeof value === "object" ? value : fallback;
}

function asString(value, fallback = "") {
  const text = String(value ?? fallback);
  return text === "undefined" || text === "null" ? fallback : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSelectorList(value) {
  const list = asArray(value);
  const output = [];
  const seen = new Set();

  for (const entry of list) {
    const text = asString(entry, "").trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }

  return output;
}

function normalizeFilterDimension(value) {
  const row = asObject(value, {});
  return {
    include: normalizeSelectorList(row.include),
    exclude: normalizeSelectorList(row.exclude),
  };
}

function createDefaultFilters() {
  return {
    sources: { include: ["*"], exclude: [] },
    types: { include: ["*"], exclude: [] },
    actors: { include: [], exclude: [] },
    tags: { include: [], exclude: [] },
  };
}

function normalizeFilters(value) {
  const row = asObject(value, {});
  const defaults = createDefaultFilters();
  return {
    sources: normalizeFilterDimension(row.sources || defaults.sources),
    types: normalizeFilterDimension(row.types || defaults.types),
    actors: normalizeFilterDimension(row.actors || defaults.actors),
    tags: normalizeFilterDimension(row.tags || defaults.tags),
  };
}

function normalizePreprocess(value) {
  const row = asObject(value, {});
  const profiles = normalizeSelectorList(row.profiles);
  const params = asObject(row.params, {});
  return {
    acceptedProfiles: [],
    rejectedProfiles: profiles.map((id) => ({
      id,
      reason: "profile_not_supported",
    })),
    params,
  };
}

function toSerializable(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {
      summary: asString(value, ""),
    };
  }
}

function createStatusSnapshot({ running, clientCount, lastError }) {
  return {
    running: !!running,
    clientCount: Math.max(0, Number(clientCount) || 0),
    lastError: asString(lastError, "").trim(),
  };
}

function selectorMatches(selector, value) {
  if (!selector || !value) return false;
  if (selector === "*") return true;
  if (selector.endsWith("*")) {
    return value.startsWith(selector.slice(0, -1));
  }
  return value === selector;
}

function anySelectorMatch(selectors, values) {
  if (!selectors.length || !values.length) return false;
  for (const selector of selectors) {
    for (const value of values) {
      if (selectorMatches(selector, value)) {
        return true;
      }
    }
  }
  return false;
}

function dimensionAccepts(dimension, values) {
  const row = asObject(dimension, {});
  const include = asArray(row.include);
  const exclude = asArray(row.exclude);

  if (anySelectorMatch(exclude, values)) {
    return false;
  }

  if (include.length === 0) {
    return true;
  }

  return anySelectorMatch(include, values);
}

function eventAcceptedByFilters(filters, mappedEvent) {
  const row = asObject(filters, {});
  const sourceValues = [asString(mappedEvent.sourceCode, "stream")];
  const typeValues = [asString(mappedEvent.typeCode, "system.upstream.event")];
  const actorValues = asArray(mappedEvent.actorSelectors);
  const tagValues = asArray(mappedEvent.tags);

  return (
    dimensionAccepts(row.sources, sourceValues) &&
    dimensionAccepts(row.types, typeValues) &&
    dimensionAccepts(row.actors, actorValues) &&
    dimensionAccepts(row.tags, tagValues)
  );
}

function hasOnlyAllowedKeys(payload, allowed) {
  for (const key of Object.keys(asObject(payload, {}))) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function requiredFieldPresent(payload, fieldName) {
  if (!Object.prototype.hasOwnProperty.call(payload, fieldName)) return false;
  const value = payload[fieldName];
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function validateCanonicalPayload(typeCode, payload) {
  const row = asObject(payload, {});
  const rule = TYPE_PAYLOAD_RULES[typeCode];
  if (!rule) return false;
  if (!hasOnlyAllowedKeys(row, rule.allowed)) return false;

  for (const fieldName of rule.required) {
    if (!requiredFieldPresent(row, fieldName)) return false;
  }

  if (typeCode === "interaction.reaction.like") {
    return asString(row.reaction_type, "").trim() === "like";
  }

  if (typeCode === "interaction.reaction.share") {
    return asString(row.reaction_type, "").trim() === "share";
  }

  if (typeCode === "moderation.message.pin") {
    return asNumber(row.sticky_length, 0) >= 1;
  }

  return true;
}

function compactString(value) {
  return asString(value, "").trim();
}

function compactPayload(value) {
  const row = asObject(value, {});
  const output = {};
  for (const [key, rawValue] of Object.entries(row)) {
    if (rawValue === undefined || rawValue === null) continue;
    if (typeof rawValue === "string" && rawValue.trim() === "") continue;
    if (Array.isArray(rawValue) && rawValue.length === 0) continue;
    output[key] = rawValue;
  }
  return output;
}

function parseSyntheticGiftChatMessage(messageText) {
  const text = compactString(messageText);
  if (!text) return null;

  const match = text.match(/^\[gift\]\s+(.+?)(?:\s*\((.+)\))?\s*$/i);
  if (!match) return null;

  const giftId = compactString(match[1]);
  if (!giftId) return null;

  const donationValue = compactString(match[2]);
  return {
    giftId,
    donationValue,
  };
}

function normalizeSyntheticGiftPayloadFromChatPayload(payload) {
  const row = asObject(payload, {});
  const parsed = parseSyntheticGiftChatMessage(row.message_text);
  if (!parsed) return null;

  const normalized = {
    gift_id: parsed.giftId,
  };

  if (parsed.donationValue) {
    normalized.donation_value = parsed.donationValue;
  }

  const passthroughKeys = [
    "source_message_id",
    "source_room_id",
    "source_create_time",
    "user_displayname",
    "user_badges",
    "user_role",
    "send_time",
    "user_image_id",
    "user_color",
  ];

  for (const key of passthroughKeys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    normalized[key] = value;
  }

  return normalized;
}

function buildActorSelectors(identity) {
  const row = asObject(identity, {});
  const selectors = [];

  const id = compactString(row.id);
  if (id) selectors.push(`id:${id.toLowerCase()}`);

  const username = compactString(row.username);
  if (username) selectors.push(`handle:${username.toLowerCase()}`);

  const displayName = compactString(row.displayName);
  if (displayName) selectors.push(`name:${displayName.toLowerCase()}`);

  const effectiveName = compactString(row.effectiveName);
  if (effectiveName) selectors.push(`name:${effectiveName.toLowerCase()}`);

  return selectors;
}

function extractActorIdentity(author) {
  const row = asObject(author, {});
  const id = compactString(row.id);
  const username = compactString(row.username);
  const displayName = compactString(row.displayName);
  const effectiveName = compactString(row.effectiveName);

  return {
    id,
    username,
    displayName,
    effectiveName,
    stableKey: id || username || displayName || effectiveName,
  };
}

function knownUserKey(sourceCode, userCode) {
  const source = compactString(sourceCode).toLowerCase() || "stream";
  const code = compactString(userCode).toLowerCase();
  if (!code) return "";
  return `${source}:${code}`;
}

function resolveKnownUserName(knownUsersByKey, sourceCode, userCode) {
  const key = knownUserKey(sourceCode, userCode);
  if (!key) return "";
  const entry = asObject(knownUsersByKey.get(key), {});
  return compactString(entry.name);
}

function rememberKnownUser(knownUsersByKey, sourceCode, { userCode, userName, avatarUrl } = {}) {
  const key = knownUserKey(sourceCode, userCode);
  if (!key) return;

  const name = compactString(userName);
  const avatar = compactString(avatarUrl);
  const current = asObject(knownUsersByKey.get(key), {});
  if (!name && !avatar && !current.name && !current.avatarUrl) return;

  const next = {
    userCode: compactString(userCode),
    name: name || compactString(current.name),
    avatarUrl: avatar || compactString(current.avatarUrl),
    updatedAt: Date.now(),
  };

  if (knownUsersByKey.has(key)) {
    knownUsersByKey.delete(key);
  }
  knownUsersByKey.set(key, next);

  while (knownUsersByKey.size > MAX_KNOWN_USERS) {
    const oldest = knownUsersByKey.keys().next();
    if (oldest.done) break;
    knownUsersByKey.delete(oldest.value);
  }
}

function rememberKnownUsersFromMappedEvent(knownUsersByKey, mappedEvent) {
  const mapped = asObject(mappedEvent, {});
  const sourceCode = compactString(mapped.sourceCode) || "stream";
  const payload = asObject(mapped.payload, {});
  const actorIdentity = asObject(mapped.actorIdentity, {});
  const actorCode = compactString(actorIdentity.id);
  const actorName =
    compactString(actorIdentity.displayName) ||
    compactString(actorIdentity.effectiveName) ||
    compactString(actorIdentity.username) ||
    compactString(payload.user_displayname);
  const actorAvatar = compactString(payload.user_image_id);

  if (actorCode) {
    rememberKnownUser(knownUsersByKey, sourceCode, {
      userCode: actorCode,
      userName: actorName,
      avatarUrl: actorAvatar,
    });
  }

  const payloadName = compactString(payload.user_displayname);
  const payloadAvatar = compactString(payload.user_image_id);
  if (!payloadName && !payloadAvatar) return;

  for (const field of KNOWN_USER_CODE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const userCode = compactString(payload[field]);
    if (!userCode) continue;
    rememberKnownUser(knownUsersByKey, sourceCode, {
      userCode,
      userName: payloadName,
      avatarUrl: payloadAvatar,
    });
  }
}

function enrichActorIdentityWithKnownUsers(knownUsersByKey, sourceCode, actorIdentity) {
  const identity = asObject(actorIdentity, {});
  const actorCode = compactString(identity.id);
  if (!actorCode) return identity;

  const resolvedName = resolveKnownUserName(knownUsersByKey, sourceCode, actorCode);
  if (!resolvedName) return identity;

  const next = {
    ...identity,
  };

  if (!compactString(next.displayName)) {
    next.displayName = resolvedName;
  }
  if (!compactString(next.effectiveName)) {
    next.effectiveName = compactString(next.displayName) || resolvedName;
  }
  next.stableKey =
    compactString(next.id) ||
    compactString(next.username) ||
    compactString(next.displayName) ||
    compactString(next.effectiveName);

  return next;
}

function enrichPayloadWithKnownUsers(knownUsersByKey, sourceCode, payload) {
  const row = asObject(payload, {});
  let changed = false;
  const next = {
    ...row,
  };

  for (const field of KNOWN_USER_CODE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const raw = row[field];
    const resolved = resolveKnownUserName(knownUsersByKey, sourceCode, raw);
    const rawText = compactString(raw);
    if (!resolved || !rawText || resolved === rawText) continue;
    next[field] = resolved;
    changed = true;
  }

  for (const field of KNOWN_USER_CODE_ARRAY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const values = Array.isArray(row[field]) ? row[field] : null;
    if (!values) continue;

    let fieldChanged = false;
    const mappedValues = values.map((value) => {
      const resolved = resolveKnownUserName(knownUsersByKey, sourceCode, value);
      const rawText = compactString(value);
      if (!resolved || !rawText || resolved === rawText) {
        return value;
      }
      fieldChanged = true;
      return resolved;
    });

    if (fieldChanged) {
      next[field] = mappedValues;
      changed = true;
    }
  }

  return changed ? next : row;
}

function extractSourceCode(event) {
  const platform = compactString(event?.platform).toLowerCase();
  if (!platform) return "stream";
  for (const [, code] of SOURCE_DICTIONARY) {
    if (code === platform) return code;
  }
  return "stream";
}

function mapToFallbackEvent(event, sourceCode) {
  const type = compactString(event?.type) || "unknown";
  const summary =
    compactString(event?.message) ||
    compactString(event?.reason) ||
    compactString(event?.state) ||
    "";

  const payload = {
    upstream: "streaming-chat-runtime",
    upstream_event: type,
  };

  if (summary) {
    payload.summary = summary;
  }

  return {
    sourceCode: sourceCode || "runtime",
    typeCode: "system.upstream.event",
    payload,
    actorIdentity: extractActorIdentity(event?.author),
    actorSelectors: buildActorSelectors(event?.author),
    tags: [],
  };
}

function mapRuntimeEvent(event) {
  const row = asObject(event, {});
  const type = compactString(row.type).toLowerCase();
  const sourceCode = extractSourceCode(row);

  if (type === "protocol") {
    const typeCode = compactString(row.typeCode);
    const payload = compactPayload(row.payload);
    if (!typeCode) {
      return null;
    }

    if (typeCode === "chat.message") {
      const normalizedGiftPayload = normalizeSyntheticGiftPayloadFromChatPayload(payload);
      if (normalizedGiftPayload) {
        return {
          sourceCode: sourceCode || "stream",
          typeCode: "monetization.donation.gift",
          payload: normalizedGiftPayload,
          actorIdentity: extractActorIdentity(row.author),
          actorSelectors: buildActorSelectors(row.author),
          tags: normalizeSelectorList(row.tags),
          fromProtocol: true,
        };
      }
    }

    return {
      sourceCode: sourceCode || "stream",
      typeCode,
      payload,
      actorIdentity: extractActorIdentity(row.author),
      actorSelectors: buildActorSelectors(row.author),
      tags: normalizeSelectorList(row.tags),
      fromProtocol: true,
    };
  }

  if (type === "chat") {
    const messageText = compactString(row.message);
    if (!messageText) {
      return null;
    }

    const actorIdentity = extractActorIdentity(row.author);
    const payload = {
      message_text: messageText,
    };

    const userDisplayName =
      actorIdentity.displayName ||
      actorIdentity.effectiveName ||
      actorIdentity.username ||
      "";
    if (userDisplayName) {
      payload.user_displayname = userDisplayName;
    }

    return {
      sourceCode: sourceCode || "stream",
      typeCode: "chat.message",
      payload,
      actorIdentity,
      actorSelectors: buildActorSelectors(row.author),
      tags: [],
    };
  }

  if (type === "gift") {
    const actorIdentity = extractActorIdentity(row.author);
    const giftRaw = asObject(row.raw, {});
    const giftDetails = asObject(giftRaw.giftDetails, {});
    const giftId = compactString(giftRaw.giftId || giftDetails.giftId);

    const repeatCount = Math.max(1, Math.floor(asNumber(giftRaw.repeatCount, 1)));
    const diamondEach = Math.max(0, Math.floor(asNumber(giftDetails.diamondCount, 0)));
    const totalDiamonds = diamondEach > 0 ? diamondEach * repeatCount : 0;
    const donationValue = totalDiamonds > 0 ? `${totalDiamonds} diamonds` : "";

    const payload = {
      donation_value: donationValue,
      gift_id: giftId,
    };

    const userDisplayName =
      actorIdentity.displayName ||
      actorIdentity.effectiveName ||
      actorIdentity.username ||
      "";
    if (userDisplayName) {
      payload.user_displayname = userDisplayName;
    }

    return {
      sourceCode: sourceCode || "stream",
      typeCode: "monetization.donation.gift",
      payload,
      actorIdentity,
      actorSelectors: buildActorSelectors(row.author),
      tags: [],
    };
  }

  if (sourceCode === "tiktok") {
    return null;
  }

  return mapToFallbackEvent(row, sourceCode || "runtime");
}

function createSessionResponse(session) {
  return {
    sessionId: session.sessionId,
    protocol: PROTOCOL_ID,
    streamUrl: `/v1/sessions/${encodeURIComponent(session.sessionId)}/stream`,
    heartbeatMs: session.heartbeatMs,
    maxIdleMs: session.maxIdleMs,
    expiresAt: new Date(session.expiresAt).toISOString(),
    revision: session.revision,
    effective: {
      filters: toSerializable(session.filters),
      preprocess: toSerializable(session.preprocess),
    },
  };
}

function createCapabilitiesResponse() {
  return {
    protocols: [PROTOCOL_ID],
    filters: ["sources", "types", "actors", "tags"],
    preprocessProfiles: [],
    preprocessParamSchemas: {},
  };
}

function createSseEventName(op) {
  if (op === "h") return "handshake";
  if (op === "b") return "heartbeat";
  if (op === "x") return "error";
  return "event";
}

function createUscpSseHttpTransport() {
  let server = null;
  let listening = false;
  let config = null;
  let lastError = "";
  let onStatusChange = null;
  let maintenanceTimer = null;
  const sessions = new Map();
  const knownUsersByKey = new Map();

  function getClientCount() {
    let total = 0;
    for (const session of sessions.values()) {
      total += session.streams.size;
    }
    return total;
  }

  function publishStatus() {
    if (typeof onStatusChange !== "function") return;

    try {
      onStatusChange(
        createStatusSnapshot({
          running: listening,
          clientCount: getClientCount(),
          lastError,
        }),
      );
    } catch {}
  }

  function registerDrop(reason, context = {}) {
    const message = compactString(reason);
    if (!message) return;
    lastError = message;

    const row = asObject(context, {});
    const event = asObject(row.event, {});
    const mapped = asObject(row.mapped, {});
    const payload =
      row.payload !== undefined
        ? row.payload
        : (mapped.payload !== undefined ? mapped.payload : event.payload);
    const details = {
      reason: message,
      typeCode: compactString(row.typeCode || mapped.typeCode || event.typeCode),
      sourceCode: compactString(row.sourceCode || mapped.sourceCode || event.platform),
      payload: toSerializable(payload),
      event: {
        type: compactString(event.type),
        platform: compactString(event.platform),
        typeCode: compactString(event.typeCode),
        at: asNumber(event.at, 0) || undefined,
      },
    };

    try {
      console.warn("[uscp-drop]", details);
    } catch {
      try {
        console.warn("[uscp-drop]", message);
      } catch {}
    }

    publishStatus();
  }

  function nextSequence(session) {
    const q = session.nextSeq;
    session.nextSeq += 1;
    return q;
  }

  function ensureActorId(session, actorIdentity) {
    const row = asObject(actorIdentity, {});
    const stableKey = compactString(row.stableKey);
    if (!stableKey) {
      return null;
    }

    const normalized = stableKey.toLowerCase();
    if (session.actorIds.has(normalized)) {
      return session.actorIds.get(normalized);
    }

    const actorId = session.nextActorId;
    session.nextActorId += 1;
    session.actorIds.set(normalized, actorId);
    return actorId;
  }

  function getSourceId(sourceCode) {
    const normalized = compactString(sourceCode).toLowerCase();
    for (const [id, code] of SOURCE_DICTIONARY) {
      if (code === normalized) return id;
    }
    return 1;
  }

  function getTypeId(typeCode) {
    const normalized = compactString(typeCode).toLowerCase();
    for (const [id, code] of TYPE_DICTIONARY) {
      if (code === normalized) return id;
    }
    return null;
  }

  function safeWrite(res, text) {
    try {
      res.write(text);
      return true;
    } catch {
      return false;
    }
  }

  function sendSseFrame(session, streamClient, frame) {
    const eventName = createSseEventName(frame.o);
    const payload = JSON.stringify(frame);
    const chunk = `event: ${eventName}\nid: ${frame.q}\ndata: ${payload}\n\n`;
    if (!safeWrite(streamClient.res, chunk)) {
      session.streams.delete(streamClient);
      return false;
    }

    const now = Date.now();
    streamClient.lastSentAt = now;
    session.lastFrameAt = now;
    return true;
  }

  function broadcastFrame(session, frame) {
    const stale = [];
    for (const streamClient of session.streams) {
      if (!sendSseFrame(session, streamClient, frame)) {
        stale.push(streamClient);
      }
    }

    for (const streamClient of stale) {
      session.streams.delete(streamClient);
    }
  }

  function closeSessionStreams(session, reason = "session closed") {
    for (const streamClient of session.streams) {
      try {
        streamClient.res.end();
      } catch {}
      try {
        streamClient.res.destroy();
      } catch {}
    }
    session.streams.clear();
    session.closedReason = reason;
  }

  function destroySession(sessionId, reason = "session closed") {
    const session = sessions.get(sessionId);
    if (!session) return;
    closeSessionStreams(session, reason);
    sessions.delete(sessionId);
  }

  function stopMaintenance() {
    if (!maintenanceTimer) return;
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }

  function startMaintenance() {
    stopMaintenance();
    maintenanceTimer = setInterval(() => {
      const now = Date.now();
      for (const session of sessions.values()) {
        if (now >= session.expiresAt) {
          destroySession(session.sessionId, "session expired");
          continue;
        }

        if (session.streams.size === 0) {
          continue;
        }

        const dueForHeartbeat = now - session.lastHeartbeatAt >= session.heartbeatMs;
        if (!dueForHeartbeat) continue;

        const frame = {
          o: "b",
          q: nextSequence(session),
          t: now,
        };
        broadcastFrame(session, frame);
        session.lastHeartbeatAt = now;
      }

      publishStatus();
    }, 1000);
  }

  function parseTokenFromQuery(urlObject) {
    try {
      return asString(urlObject.searchParams.get("token"), "").trim();
    } catch {
      return "";
    }
  }

  function parseBearerToken(req) {
    const header = asString(req?.headers?.authorization, "").trim();
    if (!header.toLowerCase().startsWith("bearer ")) return "";
    return header.slice(7).trim();
  }

  function isControlAuthorized(req) {
    if (!config?.token) return false;
    return parseBearerToken(req) === config.token;
  }

  function isStreamAuthorized(req, urlObject) {
    if (!config?.token) return false;
    const bearer = parseBearerToken(req);
    if (bearer && bearer === config.token) return true;
    return parseTokenFromQuery(urlObject) === config.token;
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;

      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) {
          reject(new Error("request_too_large"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (size === 0) {
          resolve({});
          return;
        }

        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const parsed = JSON.parse(raw);
          resolve(asObject(parsed, {}));
        } catch {
          reject(new Error("invalid_json"));
        }
      });

      req.on("error", reject);
    });
  }

  function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload ?? {});
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  function sendError(res, statusCode, code, message, details = {}) {
    sendJson(res, statusCode, {
      code,
      message,
      details: toSerializable(details),
    });
  }

  function parseSessionPath(pathname) {
    const streamMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/stream$/);
    if (streamMatch) {
      return {
        kind: "stream",
        sessionId: decodeURIComponent(streamMatch[1]),
      };
    }

    const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      return {
        kind: "session",
        sessionId: decodeURIComponent(sessionMatch[1]),
      };
    }

    return null;
  }

  function createSession(requestBody) {
    const protocol = compactString(requestBody.protocol);
    if (protocol !== PROTOCOL_ID) {
      return {
        ok: false,
        statusCode: 400,
        code: "session.invalid_request",
        message: "Unsupported protocol.",
      };
    }

    const now = Date.now();
    const sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const filters = normalizeFilters(requestBody.filters);
    const preprocess = normalizePreprocess(requestBody.preprocess);

    const session = {
      sessionId,
      protocol: PROTOCOL_ID,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      maxIdleMs: DEFAULT_MAX_IDLE_MS,
      revision: 1,
      filters,
      preprocess,
      streams: new Set(),
      nextSeq: 1,
      nextActorId: 1,
      actorIds: new Map(),
      lastHeartbeatAt: now,
      lastFrameAt: now,
    };

    sessions.set(sessionId, session);

    return {
      ok: true,
      statusCode: 201,
      session,
    };
  }

  function patchSession(session, patchBody) {
    const hasFilters = Object.prototype.hasOwnProperty.call(patchBody, "filters");
    const hasPreprocess = Object.prototype.hasOwnProperty.call(patchBody, "preprocess");

    if (!hasFilters && !hasPreprocess) {
      return {
        ok: false,
        statusCode: 400,
        code: "session.invalid_request",
        message: "Patch payload must include filters and/or preprocess.",
      };
    }

    if (hasFilters) {
      session.filters = normalizeFilters(patchBody.filters);
    }

    if (hasPreprocess) {
      session.preprocess = normalizePreprocess(patchBody.preprocess);
    }

    session.revision += 1;

    return {
      ok: true,
    };
  }

  function buildHandshakeFrame(session) {
    const now = Date.now();
    const q = nextSequence(session);
    return {
      o: "h",
      v: PROTOCOL_ID,
      sid: session.sessionId,
      q,
      t: now,
      hb: session.heartbeatMs,
      src: SOURCE_DICTIONARY.map(([id, code]) => [id, code]),
      typ: TYPE_DICTIONARY.map(([id, code]) => [id, code]),
      cap: {
        filters: ["sources", "types", "actors", "tags"],
        preprocessProfiles: [],
      },
    };
  }

  async function handleRequest(req, res) {
    const method = asString(req.method, "GET").toUpperCase();
    const url = new URL(asString(req.url, "/"), "http://localhost");
    const pathname = asString(url.pathname, "/");

    if (pathname === "/v1/capabilities" && method === "GET") {
      if (!isControlAuthorized(req)) {
        sendError(res, 401, "auth.invalid_token", "Unauthorized.");
        return;
      }
      sendJson(res, 200, createCapabilitiesResponse());
      return;
    }

    if (pathname === "/v1/sessions" && method === "POST") {
      if (!isControlAuthorized(req)) {
        sendError(res, 401, "auth.invalid_token", "Unauthorized.");
        return;
      }

      let requestBody = {};
      try {
        requestBody = await readJsonBody(req);
      } catch (error) {
        sendError(res, 400, "session.invalid_request", "Invalid JSON payload.", {
          reason: asString(error?.message, "invalid_json"),
        });
        return;
      }

      const created = createSession(requestBody);
      if (!created.ok) {
        sendError(res, created.statusCode, created.code, created.message);
        return;
      }

      sendJson(res, created.statusCode, createSessionResponse(created.session));
      publishStatus();
      return;
    }

    const parsedPath = parseSessionPath(pathname);
    if (!parsedPath) {
      sendError(res, 404, "session.not_found", "Route not found.");
      return;
    }

    const session = sessions.get(parsedPath.sessionId);
    if (!session) {
      sendError(res, 404, "session.not_found", "Session not found.");
      return;
    }

    if (Date.now() >= session.expiresAt) {
      destroySession(parsedPath.sessionId, "session expired");
      sendError(res, 410, "session.expired", "Session expired.");
      return;
    }

    if (parsedPath.kind === "stream") {
      if (method !== "GET") {
        sendError(res, 405, "session.invalid_request", "Method not allowed.");
        return;
      }

      if (!isStreamAuthorized(req, url)) {
        sendError(res, 401, "auth.invalid_token", "Unauthorized.");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }
      safeWrite(res, ": stream-start\n\n");

      const streamClient = {
        res,
        lastSentAt: Date.now(),
      };
      session.streams.add(streamClient);

      const handshake = buildHandshakeFrame(session);
      sendSseFrame(session, streamClient, handshake);
      session.lastHeartbeatAt = Date.now();

      publishStatus();

      req.on("close", () => {
        session.streams.delete(streamClient);
        publishStatus();
      });
      req.on("aborted", () => {
        session.streams.delete(streamClient);
        publishStatus();
      });
      res.on("close", () => {
        session.streams.delete(streamClient);
        publishStatus();
      });
      return;
    }

    if (!isControlAuthorized(req)) {
      sendError(res, 401, "auth.invalid_token", "Unauthorized.");
      return;
    }

    if (method === "GET") {
      sendJson(res, 200, createSessionResponse(session));
      return;
    }

    if (method === "DELETE") {
      destroySession(parsedPath.sessionId, "session deleted");
      sendJson(res, 200, {
        sessionId: parsedPath.sessionId,
        deleted: true,
      });
      publishStatus();
      return;
    }

    if (method === "PATCH") {
      let patchBody = {};
      try {
        patchBody = await readJsonBody(req);
      } catch (error) {
        sendError(res, 400, "session.invalid_request", "Invalid JSON payload.", {
          reason: asString(error?.message, "invalid_json"),
        });
        return;
      }

      const patched = patchSession(session, patchBody);
      if (!patched.ok) {
        sendError(res, patched.statusCode, patched.code, patched.message);
        return;
      }

      sendJson(res, 200, createSessionResponse(session));
      return;
    }

    sendError(res, 405, "session.invalid_request", "Method not allowed.");
  }

  function stop() {
    config = null;
    lastError = "";
    listening = false;
    knownUsersByKey.clear();
    stopMaintenance();

    for (const session of sessions.values()) {
      closeSessionStreams(session, "server closing");
    }
    sessions.clear();

    if (!server) {
      publishStatus();
      return;
    }

    const activeServer = server;
    server = null;

    try {
      activeServer.close(() => {
        listening = false;
        publishStatus();
      });
    } catch {
      listening = false;
      publishStatus();
    }
  }

  function start({ host, port, token, onStatusChange: nextOnStatusChange }) {
    stop();

    config = {
      host: compactString(host) || "0.0.0.0",
      port: Math.max(0, Math.floor(asNumber(port, 0))),
      token: compactString(token),
    };
    onStatusChange = typeof nextOnStatusChange === "function" ? nextOnStatusChange : null;
    lastError = "";

    server = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        lastError = asString(error?.message ?? error, "internal error");
        sendError(res, 500, "stream.internal_error", "Internal server error.");
        publishStatus();
      });
    });

    server.on("listening", () => {
      listening = true;
      startMaintenance();
      publishStatus();
    });

    server.on("error", (error) => {
      listening = false;
      lastError = asString(error?.message ?? error, "server error");
      publishStatus();
    });

    server.listen({
      host: config.host,
      port: config.port,
    });
  }

  function restart({ host, port, token, onStatusChange: nextOnStatusChange }) {
    const nextConfig = {
      host: compactString(host) || "0.0.0.0",
      port: Math.max(0, Math.floor(asNumber(port, 0))),
      token: compactString(token),
    };

    const same =
      !!server &&
      !!config &&
      config.host === nextConfig.host &&
      config.port === nextConfig.port &&
      config.token === nextConfig.token;

    if (same) {
      onStatusChange = typeof nextOnStatusChange === "function" ? nextOnStatusChange : null;
      publishStatus();
      return;
    }

    start({
      host: nextConfig.host,
      port: nextConfig.port,
      token: nextConfig.token,
      onStatusChange: nextOnStatusChange,
    });
  }

  function broadcastChat({ platform, author, message }) {
    const body = compactString(message);
    if (!body) return;

    broadcastEvent({
      type: "chat",
      platform: compactString(platform) || "stream",
      at: Date.now(),
      author: {
        effectiveName: compactString(author) || "unknown",
      },
      message: body,
    });
  }

  function broadcastEvent(event) {
    const mapped = mapRuntimeEvent(event);
    if (!mapped) {
      const row = asObject(event, {});
      if (compactString(row.platform).toLowerCase() === "tiktok") {
        registerDrop("Dropped unmapped TikTok event before stream serialization.", { event });
      }
      return;
    }

    rememberKnownUsersFromMappedEvent(knownUsersByKey, mapped);
    const mappedSourceCode = compactString(mapped.sourceCode) || "stream";
    const mappedActorIdentity = enrichActorIdentityWithKnownUsers(
      knownUsersByKey,
      mappedSourceCode,
      mapped.actorIdentity,
    );
    const mappedPayload = enrichPayloadWithKnownUsers(
      knownUsersByKey,
      mappedSourceCode,
      mapped.payload,
    );
    const mappedEvent =
      mappedPayload === mapped.payload && mappedActorIdentity === mapped.actorIdentity
        ? mapped
        : {
          ...mapped,
          payload: mappedPayload,
          actorIdentity: mappedActorIdentity,
          actorSelectors: buildActorSelectors(mappedActorIdentity),
        };

    for (const session of sessions.values()) {
      if (session.streams.size === 0) continue;
      if (!eventAcceptedByFilters(session.filters, mappedEvent)) continue;

      let payload = toSerializable(mappedEvent.payload);
      let typeCode = mappedEvent.typeCode;
      let actorSelectors = asArray(mappedEvent.actorSelectors);
      let actorIdentity = mappedEvent.actorIdentity;

      if (!validateCanonicalPayload(typeCode, payload)) {
        if (mappedEvent.fromProtocol || compactString(mappedEvent.sourceCode).toLowerCase() === "tiktok") {
          registerDrop(`Dropped invalid canonical payload for ${typeCode}.`, {
            event,
            mapped: mappedEvent,
            typeCode,
            sourceCode: mappedEvent.sourceCode,
            payload,
          });
          continue;
        }

        const fallback = mapToFallbackEvent(event, mappedEvent.sourceCode);
        if (!validateCanonicalPayload(fallback.typeCode, fallback.payload)) {
          registerDrop("Dropped fallback payload that failed canonical validation.", {
            event,
            mapped: fallback,
            typeCode: fallback.typeCode,
            sourceCode: fallback.sourceCode,
            payload: fallback.payload,
          });
          continue;
        }

        typeCode = fallback.typeCode;
        payload = fallback.payload;
        actorSelectors = fallback.actorSelectors;
        actorIdentity = fallback.actorIdentity;
      }

      const typeId = getTypeId(typeCode);
      if (!typeId) {
        registerDrop(`Dropped event with unknown type code '${typeCode}'.`, {
          event,
          mapped: mappedEvent,
          typeCode,
          sourceCode: mappedEvent.sourceCode,
          payload,
        });
        continue;
      }

      const sourceId = getSourceId(mappedEvent.sourceCode);
      const actorId = ensureActorId(session, actorIdentity);

      const finalMapped = {
        ...mappedEvent,
        typeCode,
        payload,
        actorSelectors,
      };
      if (!eventAcceptedByFilters(session.filters, finalMapped)) continue;

      const frame = {
        o: "e",
        q: nextSequence(session),
        t: Date.now(),
        s: sourceId,
        y: typeId,
        p: payload,
      };

      if (actorId) {
        frame.a = actorId;
      }

      broadcastFrame(session, frame);
      session.lastHeartbeatAt = Date.now();
    }

    publishStatus();
  }

  return {
    start,
    stop,
    restart,
    broadcastChat,
    broadcastEvent,
  };
}

module.exports = {
  createUscpSseHttpTransport,
  __private: {
    validateCanonicalPayload,
    normalizeFilters,
    normalizePreprocess,
    mapRuntimeEvent,
    eventAcceptedByFilters,
  },
};
