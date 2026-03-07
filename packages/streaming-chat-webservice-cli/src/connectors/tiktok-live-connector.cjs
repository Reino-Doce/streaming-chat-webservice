const fs = require("fs");
const path = require("path");

let connectorModule = null;
let connectorLoadFailed = false;

const DEFAULT_VERBOSE_LOG_FILENAME = "tiktok-live-connector.log";
const MAX_BATTLE_ARMY_USERS = 60;
const MAX_BATTLE_ITEMS = 4;

function asString(value, fallback = "") {
  const text = String(value ?? fallback);
  return text === "undefined" || text === "null" ? fallback : text;
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asEntriesArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function asInt(value, fallback = Number.NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function asNum(value, fallback = Number.NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalInt(value) {
  const parsed = asInt(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const x = value.trim().toLowerCase();
    if (x === "true" || x === "1") return true;
    if (x === "false" || x === "0") return false;
  }
  return fallback;
}

function compactString(value) {
  return asString(value, "").trim();
}

function serializeForLog(value) {
  const seen = new WeakSet();
  try {
    const serialized = JSON.stringify(value, (_key, candidate) => {
      if (typeof candidate === "bigint") return String(candidate);
      if (typeof candidate === "function") return `[function ${candidate.name || "anonymous"}]`;
      if (typeof candidate === "symbol") return String(candidate);
      if (!candidate || typeof candidate !== "object") return candidate;
      if (seen.has(candidate)) return "[[circular]]";
      seen.add(candidate);
      return candidate;
    });

    if (serialized === undefined) {
      return null;
    }

    return JSON.parse(serialized);
  } catch {
    return {
      _serialization_error: true,
      value: asString(value, ""),
    };
  }
}

function resolveVerboseLogPath(explicitPath = "") {
  const fromInput = compactString(explicitPath);
  if (fromInput) return path.resolve(fromInput);

  const fromEnv = compactString(process.env.RD_TIKTOK_VERBOSE_LOG_PATH);
  if (fromEnv) return path.resolve(fromEnv);

  return path.resolve(process.cwd(), "logs", DEFAULT_VERBOSE_LOG_FILENAME);
}

function createVerboseRawEventLogger(args = {}) {
  const row = asObject(args, {});
  const enabled = asBool(row.enabled, false);
  const logPath = enabled ? resolveVerboseLogPath(row.logPath) : "";

  function writeLine(text) {
    if (!enabled || !logPath) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${text}\n`, "utf8");
    } catch {}
  }

  function writeConnectorEvent(eventName, payload, source = "webcast") {
    if (!enabled) return;
    const timestamp = new Date().toISOString();
    const rawRecord = {
      source: compactString(source) || "webcast",
      event: compactString(eventName),
      raw: serializeForLog(payload),
    };
    writeLine(`${timestamp} ${JSON.stringify(rawRecord)}`);
  }

  return {
    enabled,
    logPath,
    writeConnectorEvent,
  };
}

function firstString(candidates) {
  for (const value of asArray(candidates)) {
    const text = compactString(value);
    if (text) return text;
  }
  return "";
}

function scalar(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const text = value.trim();
    return text || undefined;
  }
  return undefined;
}

function compactPayload(payload) {
  const out = {};
  for (const [k, v] of Object.entries(asObject(payload, {}))) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function hasRequired(payload, field) {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return false;
  const value = payload[field];
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function normalizeUniqueId(value) {
  return compactString(value).replace(/^@+/, "").toLowerCase();
}

function extractErrorText(value, seen = new Set(), depth = 0) {
  if (depth > 4) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  const row = value;
  for (const part of [row.message, row.reason, row.error, row.details, row.statusMessage, row.msg]) {
    const text = extractErrorText(part, seen, depth + 1);
    if (text && text !== "[object Object]") return text;
  }
  if (Array.isArray(row.errors)) {
    const list = row.errors.map((x) => extractErrorText(x, seen, depth + 1)).filter(Boolean).join(" | ");
    if (list) return list;
  }
  return "";
}

function formatConnectError(error) {
  const msg = extractErrorText(error);
  const nested = Array.isArray(error?.errors)
    ? error.errors.map((x) => extractErrorText(x)).filter(Boolean).join(" | ")
    : "";
  const text = `${msg} ${nested}`.toLowerCase();
  if (text.includes("user_not_found")) return "Usuario do TikTok nao encontrado. Verifique o @ informado.";
  if (text.includes("fetchisliveerror")) return "Nao foi possivel confirmar a live. Verifique se o usuario esta ao vivo.";
  if (nested) return nested;
  if (msg) return msg;
  return "Falha ao conectar no TikTok Live.";
}

function getConnectorModule() {
  if (connectorModule) return connectorModule;
  if (connectorLoadFailed) return null;
  try {
    connectorModule = require("tiktok-live-connector");
    return connectorModule;
  } catch {
    connectorLoadFailed = true;
    return null;
  }
}

function extractAuthorIdentity(data, authorMode = "username") {
  const row = asObject(data, {});
  const user = asObject(row.user, {});
  const username = compactString(row.uniqueId) || compactString(user.uniqueId);
  const displayName = compactString(row.nickname) || compactString(user.nickname);
  const id = compactString(row.userId) || compactString(user.userId);
  const effectiveName = authorMode === "display-name"
    ? (displayName || username || id || "Desconhecido")
    : (username || displayName || id || "Desconhecido");
  return {
    id: id || undefined,
    username: username || undefined,
    displayName: displayName || undefined,
    effectiveName,
  };
}

function displayName(author) {
  const row = asObject(author, {});
  return compactString(row.displayName) || compactString(row.effectiveName) || compactString(row.username) || "";
}

function normalizeHttpUrl(value) {
  const text = compactString(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("//")) return `https:${text}`;
  return "";
}

function extractUrlCandidate(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return normalizeHttpUrl(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = extractUrlCandidate(entry);
      if (url) return url;
    }
    return "";
  }

  if (typeof value !== "object") return "";
  const row = asObject(value, {});
  for (const key of ["url", "uri", "download_url", "downloadUrl", "open_web_url", "openWebUrl"]) {
    const url = normalizeHttpUrl(row[key]);
    if (url) return url;
  }

  for (const key of ["url_list", "urlList", "urls"]) {
    const url = extractUrlCandidate(row[key]);
    if (url) return url;
  }

  return "";
}

function extractUserImageId(data) {
  const row = asObject(data, {});
  const user = asObject(row.user, {});

  const candidates = [
    row.user_image_id,
    row.userImageId,
    row.userImage,
    row.profilePictureUrl,
    row.profilePicture,
    row.avatarThumbUrl,
    row.avatarMediumUrl,
    row.avatarLargeUrl,
    row.avatarUrl,
    row.avatar,
    row.avatarThumb,
    row.avatarMedium,
    row.avatarLarger,
    row.profilePictureUrls,
    row.profilePictureUrlList,
    user.user_image_id,
    user.userImageId,
    user.userImage,
    user.profilePictureUrl,
    user.profilePicture,
    user.avatarThumbUrl,
    user.avatarMediumUrl,
    user.avatarLargeUrl,
    user.avatarUrl,
    user.avatar,
    user.avatarThumb,
    user.avatarMedium,
    user.avatarLarger,
    user.profilePictureUrls,
    user.profilePictureUrlList,
  ];

  for (const candidate of candidates) {
    const url = extractUrlCandidate(candidate);
    if (url) return url;
  }

  return "";
}

function buildUserPayload(data, authorMode) {
  const author = extractAuthorIdentity(data, authorMode);
  const payload = {};
  const name = displayName(author);
  if (name) payload.user_displayname = name;

  const userImageId = extractUserImageId(data);
  if (userImageId) payload.user_image_id = userImageId;
  return payload;
}

function sourceMeta(data) {
  const row = asObject(data, {});
  const common = asObject(row.common, {});
  const meta = {};
  const sourceMessageId = firstString([common.msgId, row.msgId, common.logId]);
  const sourceRoomId = firstString([common.roomId, row.roomId]);
  const rawTime = common.createTime ?? row.createTime ?? row.timestampMs;
  const num = asInt(rawTime);
  if (sourceMessageId) meta.source_message_id = sourceMessageId;
  if (sourceRoomId) meta.source_room_id = sourceRoomId;
  if (Number.isFinite(num) && num >= 0) meta.source_create_time = num;
  return meta;
}

function buildEvent(typeCode, data, authorMode, payload, required = []) {
  const finalPayload = compactPayload({ ...sourceMeta(data), ...asObject(payload, {}) });
  for (const field of required) {
    if (!hasRequired(finalPayload, field)) return null;
  }
  return {
    type: "protocol",
    platform: "tiktok",
    at: Date.now(),
    author: extractAuthorIdentity(data, authorMode),
    typeCode,
    payload: finalPayload,
  };
}

function parsePinAction(action) {
  const n = asInt(action);
  if (n === 1) return "pin";
  if (n === 2 || n === 0) return "unpin";
  const text = compactString(action).toLowerCase();
  if (!text) return null;
  if (text.includes("unpin") || text.includes("cancel") || text.includes("remove")) return "unpin";
  if (text.includes("pin")) return "pin";
  return null;
}

function parseNonNegativeLevel(value) {
  const parsed = asInt(value, Number.NaN);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function extractFanLevel(data) {
  const row = asObject(data, {});
  const notice = asObject(row?.FanTicketRoomNotice, {});
  for (const candidate of [notice.level, notice.fanLevel, row.level, row.fanLevel]) {
    const level = parseNonNegativeLevel(candidate);
    if (level !== undefined) return level;
  }
  return undefined;
}

function displayPattern(value) {
  const row = asObject(value, {});
  return firstString([row.defaultPattern, row.text, value]);
}

function extractBarrageUser(data) {
  const row = asObject(data, {});
  const pieces = asArray(row?.commonBarrageContent?.piecesList);
  for (const piece of pieces) {
    const user = asObject(piece?.userValue?.user, {});
    if (Object.keys(user).length > 0) return user;
  }

  const fansLevelUser = asObject(row?.fansLevelParam?.user, {});
  if (Object.keys(fansLevelUser).length > 0) return fansLevelUser;

  const userGradeUser = asObject(row?.userGradeParam?.user, {});
  if (Object.keys(userGradeUser).length > 0) return userGradeUser;

  return {};
}

function normalizeLinkedUsers(rawLinkedUsers) {
  const source = asEntriesArray(rawLinkedUsers);
  const normalized = [];

  for (const entry of source) {
    const row = asObject(entry, {});
    const user = asObject(row.user ?? row.User ?? row, {});
    const linkedUser = compactPayload({
      user_id: firstString([user.userId, user.idStr, user.uid, row.userId, row.UserId]),
      unique_id: firstString([user.uniqueId, user.displayId, row.uniqueId, row.displayId]),
      nickname: firstString([user.nickname, user.displayName, row.nickname]),
      link_status: scalar(row.linkStatus ?? row.link_status),
      user_position: scalar(row.userPosition ?? row.user_position),
      link_type: scalar(row.linkType ?? row.link_type),
    });

    if (Object.keys(linkedUser).length > 0) {
      normalized.push(linkedUser);
    }
  }

  return normalized;
}

function normalizeCohostUserInfos(rawUserInfos) {
  const source = asEntriesArray(rawUserInfos);
  const normalized = [];

  for (const entry of source) {
    const row = asObject(entry, {});
    const userInfo = compactPayload({
      user_id: firstString([row.userId, row.idStr, row.uid]),
      unique_id: firstString([row.displayId, row.uniqueId]),
      nickname: firstString([row.nickname, row.displayName]),
      change_type: scalar(row.changeType),
      link_status: scalar(row.linkStatus),
      user_position: scalar(row.userPosition),
    });

    if (Object.keys(userInfo).length > 0) {
      normalized.push(userInfo);
    }
  }

  return normalized;
}

function normalizeFanTicketUsers(notice) {
  const row = asObject(notice, {});
  const source = asEntriesArray(row?.UserFanTicketList);
  const normalized = [];

  for (const entry of source) {
    const item = asObject(entry, {});
    const nestedUser = asObject(item?.User ?? item?.user, {});
    const userRow = compactPayload({
      user_id: firstString([item?.UserId, item?.userId, nestedUser?.userId, nestedUser?.idStr, nestedUser?.uid]),
      fan_ticket: toOptionalInt(item?.FanTicket ?? item?.fanTicket),
      match_rank: toOptionalInt(item?.MatchRank ?? item?.matchRank),
    });

    if (Object.keys(userRow).length > 0) {
      normalized.push(userRow);
    }
  }

  return normalized;
}

function collectUserIds(...values) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const text = compactString(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push(text);
  };
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const x of value) visit(x);
      return;
    }
    if (!value || typeof value !== "object") {
      push(value);
      return;
    }
    push(value.userId);
    push(value.uid);
    push(value.id);
    push(value.fromUserId);
  };
  for (const value of values) visit(value);
  return out;
}

function normalizeBattleArmyUser(entry) {
  const row = asObject(entry, {});
  const score = asInt(row.score, Number.NaN);
  if (!Number.isFinite(score) || score < 0) return null;

  const normalized = {
    score: Math.floor(score),
  };

  const nickname = firstString([row.nickname, row.userDisplayname, row.user_displayname, row.displayName]);
  if (nickname) {
    normalized.nickname = nickname;
  }

  const userId = firstString([row.userIdStr, row.user_id_str, row.userId, row.user_id]);
  if (userId) {
    normalized.user_id_str = userId;
  }

  const avatarThumb = asObject(row.avatarThumb ?? row.avatar_thumb, {});
  const avatarUrl = extractUrlCandidate([avatarThumb.url, avatarThumb.url_list, row.userImageId, row.user_image_id]);
  if (avatarUrl) {
    normalized.avatar_thumb = { url: [avatarUrl] };
  }

  return normalized;
}

function normalizeBattleItems(rawBattleItems) {
  const source = asObject(rawBattleItems, {});
  const entries = Object.entries(source);
  if (entries.length === 0) return undefined;

  const normalized = {};
  for (const [sideKeyRaw, sideValue] of entries.slice(0, MAX_BATTLE_ITEMS)) {
    const sideRow = asObject(sideValue, {});
    const sideKey = firstString([sideRow.anchorIdStr, sideRow.anchor_id_str, sideKeyRaw]);
    if (!sideKey) continue;

    const side = {};

    const anchorId = firstString([sideRow.anchorIdStr, sideRow.anchor_id_str, sideRow.anchorId, sideRow.anchor_id, sideKey]);
    if (anchorId) {
      side.anchor_id_str = anchorId;
    }

    const hostScore = asInt(sideRow.hostScore ?? sideRow.host_score, Number.NaN);
    if (Number.isFinite(hostScore) && hostScore >= 0) {
      side.host_score = Math.floor(hostScore);
    }

    const viewerScore = asInt(sideRow.viewerScore ?? sideRow.viewer_score, Number.NaN);
    if (Number.isFinite(viewerScore) && viewerScore >= 0) {
      side.viewer_score = Math.floor(viewerScore);
    }

    const streamerScore = asInt(sideRow.streamerScore ?? sideRow.streamer_score, Number.NaN);
    if (Number.isFinite(streamerScore) && streamerScore >= 0) {
      side.streamer_score = Math.floor(streamerScore);
    }

    const totalScore = asInt(sideRow.totalScore ?? sideRow.total_score, Number.NaN);
    if (Number.isFinite(totalScore) && totalScore >= 0) {
      side.total_score = Math.floor(totalScore);
    }

    const userArmyRaw = asArray(sideRow.userArmy ?? sideRow.user_army);
    const userArmy = userArmyRaw
      .map((entry) => normalizeBattleArmyUser(entry))
      .filter(Boolean)
      .slice(0, MAX_BATTLE_ARMY_USERS);

    if (userArmy.length > 0) {
      side.user_army = userArmy;
    }

    if (Object.keys(side).length > 0) {
      normalized[sideKey] = side;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mapLinkMicArmiesEvent(data, authorMode) {
  const d = asObject(data, {});
  const battleSettings = asObject(d?.battleSettings ?? d?.battle_settings, {});
  return buildEvent("competition.link_mic_battle.points.updated", d, authorMode, {
    battle_id: firstString([d?.battleId]),
    battle_status: scalar(d?.battleStatus),
    channel_id: firstString([d?.channelId]),
    from_user_id: firstString([d?.fromUserId]),
    gift_id: firstString([d?.giftId]),
    gift_count: asInt(d?.giftCount),
    total_diamond_count: asInt(d?.totalDiamondCount),
    repeat_count: asInt(d?.repeatCount),
    battle_start_time_ms: asInt(battleSettings?.startTimeMs ?? battleSettings?.start_time_ms),
    battle_end_time_ms: asInt(battleSettings?.endTimeMs ?? battleSettings?.end_time_ms),
    trigger_critical_strike: asBool(d?.triggerCriticalStrike, false),
    battle_items: normalizeBattleItems(d?.battleItems ?? d?.battle_items),
  }, ["battle_id", "battle_status"]);
}

function mapImDeleteEvent(data, authorMode) {
  return buildEvent("moderation.message.delete", data, authorMode, {
    message_id: firstString([
      asArray(data?.deleteMsgIdsList)[0],
      data?.common?.msgId,
      data?.msgId,
    ]),
  }, ["message_id"]);
}

function buildMappers() {
  return {
    chat: (d, m) => buildEvent(
        "chat.message",
        d,
        m,
        {
          message_text: compactString(d?.comment),
        message_language: firstString([d?.contentLanguage]),
          ...buildUserPayload(d, m),
        },
        ["message_text"],
      ),
    gift: (d, m) => {
      const g = asObject(d, {});
      const details = asObject(g.giftDetails, {});
      const giftId = firstString([g.giftId, details.giftId]);
      const repeats = Math.max(1, asInt(g.repeatCount, 1));
      const diamonds = Math.max(0, asInt(details.diamondCount, 0)) * repeats;
      const donationValue = firstString([g.donationValue, g.diamondValue, diamonds > 0 ? `${diamonds} diamonds` : ""]);
      return buildEvent(
        "monetization.donation.gift",
        d,
        m,
        {
          donation_value: donationValue,
          gift_id: giftId,
          gift_amount: repeats,
          combo_count: asInt(g?.comboCount),
          gift_diamond_count: asInt(details?.diamondCount),
          gift_description: firstString([g?.common?.describe, g?.describe]),
          ...buildUserPayload(d, m),
        },
        ["donation_value", "gift_id"],
      );
    },
    member: (d, m) => buildEvent(
      "audience.member.entered",
      d,
      m,
      {
        action: scalar(d?.action),
        member_count: asInt(d?.memberCount),
        enter_type: scalar(d?.enterType),
        display_style: scalar(d?.displayStyle),
        user_id: firstString([d?.userId, d?.user?.userId]),
        pop_text: firstString([d?.popStr, d?.actionDescription]),
        action_description: firstString([d?.actionDescription]),
        display_pattern: displayPattern(d?.common?.displayText),
        ...buildUserPayload(d, m),
      },
    ),
    roomUser: (d, m) => buildEvent(
      "audience.room.presence.updated",
      d,
      m,
      {
        viewer_count: asInt(d?.viewerCount),
        total_user: asInt(d?.totalUser),
        popularity: firstString([d?.popularity]),
        anonymous: asBool(d?.anonymous, false),
        anonymous_count: asInt(d?.anonymous),
      },
    ),
    social: (d, m) => buildEvent(
      "interaction.social.activity",
      d,
      m,
      {
        social_action: scalar(d?.action),
        share_type: scalar(d?.shareType),
        share_target: scalar(d?.shareTarget),
        follow_count: asInt(d?.followCount),
        share_count: asInt(d?.shareCount),
        display_pattern: displayPattern(d?.common?.displayText),
        ...buildUserPayload(d, m),
      },
    ),
    like: (d, m) => buildEvent("interaction.reaction.like", d, m, {
      reaction_type: "like",
      reaction_amount: asInt(d?.likeCount),
      total_like_count: asInt(d?.totalLikeCount),
      display_pattern: displayPattern(d?.common?.displayText),
      ...buildUserPayload(d, m),
    }, ["reaction_type"]),
    questionNew: (d, m) => { const x = asObject(d?.details, {}); return buildEvent("chat.question.created", d, m, { question_text: firstString([x.questionText, x.content, x.defaultPattern, x.text]), question_id: firstString([x.questionId, x.id, x.msgId]) }); },
    linkMicBattle: (d, m) => buildEvent(
      "competition.link_mic_battle.started",
      d,
      m,
      {
        battle_id: firstString([d?.battleId]),
        battle_action: scalar(d?.action),
        channel_id: firstString([d?.battleSetting?.channelId]),
        participant_user_ids: collectUserIds(d?.teamUsers, d?.armies, d?.anchorInfo),
        invitee_gift_permission_type: scalar(d?.inviteeGiftPermissionType),
        bubble_text: firstString([d?.bubbleText?.defaultPattern, d?.bubbleText?.text, d?.bubbleText]),
      },
      ["battle_id", "battle_action"],
    ),
    linkMicArmies: (d, m) => mapLinkMicArmiesEvent(d, m),
    liveIntro: (d, m) => buildEvent(
      "stream.intro.updated",
      d,
      m,
      {
        intro_mode: scalar(d?.introMode),
        description: firstString([d?.description]),
        language: firstString([d?.language]),
        host_user_id: firstString([d?.host?.userId]),
        host_nickname: firstString([d?.host?.nickname]),
      },
    ),
    emote: (d, m) => { const ids = asArray(d?.emoteList).map((x) => firstString([x?.emoteId, x?.id])).filter(Boolean); return buildEvent("chat.emote.reaction", d, m, { emote_ids: ids, emote_count: ids.length }); },
    envelope: (d, m) => { const i = asObject(d?.envelopeInfo, {}); const t = asObject(d?.display, {}); return buildEvent("monetization.envelope.updated", d, m, { envelope_id: firstString([i.id, i.envelopeId]), display: firstString([t.defaultPattern, t.text, d?.display]) }); },
    follow: (d, m) => buildEvent(
      "audience.followage.updated",
      d,
      m,
      {
        followage_type: "follow",
        action: scalar(d?.action),
        share_type: scalar(d?.shareType),
        follow_count: asInt(d?.followCount),
        share_count: asInt(d?.shareCount),
        display_pattern: displayPattern(d?.common?.displayText),
        ...buildUserPayload(d, m),
      },
      ["followage_type"],
    ),
    share: (d, m) => buildEvent(
      "interaction.reaction.share",
      d,
      m,
      {
        reaction_type: "share",
        reaction_amount: asInt(d?.shareCount),
        action: scalar(d?.action),
        share_type: scalar(d?.shareType),
        share_count: asInt(d?.shareCount),
        follow_count: asInt(d?.followCount),
        display_pattern: displayPattern(d?.common?.displayText),
        ...buildUserPayload(d, m),
      },
      ["reaction_type"],
    ),
    streamEnd: (d, m) => buildEvent("stream.lifecycle.ended", d, m, {
      action: scalar(d?.action),
      end_action: scalar(d?.action),
    }),
    controlMessage: (d, m) => buildEvent("stream.control.updated", d, m, {
      action: scalar(d?.action),
      control_action: scalar(d?.action),
      tips: firstString([d?.tips]),
      float_text: firstString([d?.floatText, d?.perceptionAudienceText]),
      float_style: scalar(d?.floatStyle),
      message_scene: firstString([d?.common?.sei?.uniqueId?.messageScene]),
    }),
    barrage: (d, m) => {
      const c = asObject(d?.content, {});
      const barrageUser = extractBarrageUser(d);
      const barrageUserDisplayName = firstString([barrageUser?.nickname, barrageUser?.displayId, barrageUser?.uniqueId]);
      const userPayload = buildUserPayload(d, m);
      const normalizedCurrentDisplayName = compactString(userPayload.user_displayname).toLowerCase();
      if (
        barrageUserDisplayName
        && (
          !userPayload.user_displayname
          || normalizedCurrentDisplayName === "desconhecido"
          || normalizedCurrentDisplayName === "unknown"
        )
      ) {
        userPayload.user_displayname = barrageUserDisplayName;
      }

      return buildEvent("audience.room_join", d, m, {
        join_event: scalar(d?.event),
        msg_type: scalar(d?.msgType),
        sub_type: firstString([d?.subType]),
        content: firstString([c.defaultPattern, c.text]),
        duration_ms: asInt(d?.duration),
        scene: scalar(d?.scene),
        barrage_user_id: firstString([barrageUser?.userId, barrageUser?.idStr, barrageUser?.uid]),
        barrage_user_unique_id: firstString([barrageUser?.displayId, barrageUser?.uniqueId]),
        barrage_user_displayname: barrageUserDisplayName,
        fan_level_current_grade: toOptionalInt(d?.fansLevelParam?.currentGrade),
        user_level_current_grade: toOptionalInt(d?.userGradeParam?.currentGrade),
        level_value: firstString([c?.piecesList?.[0]?.stringValue]),
        ...userPayload,
      });
    },
    hourlyRank: (d, m) => buildEvent("audience.rank.hourly.updated", d, m, { rank_data: firstString([d?.data?.defaultPattern, d?.data]), rank_data2: firstString([d?.data2?.defaultPattern, d?.data2]) }),
    goalUpdate: (d, m) => { const g = asObject(d?.goal, {}); return buildEvent("stream.goal.progress.updated", d, m, { goal_id: firstString([g.goalId, g.id]), contribute_count: asInt(d?.contributeCount), contribute_score: asNum(d?.contributeScore), update_source: scalar(d?.updateSource) }); },
    roomMessage: (d, m) => {
      const c = asObject(d?.content, {});
      return buildEvent("stream.notice.announced", d, m, {
        content: firstString([c.defaultPattern, c.text, d?.content]),
        display_pattern: displayPattern(d?.common?.displayText),
        source_type: scalar(d?.source),
        source: scalar(d?.source),
        scene: scalar(d?.scene),
        is_welcome: asBool(d?.isWelcome, false),
        show_duration_ms: asInt(d?.showDurationMs),
      });
    },
    captionMessage: (d, m) => buildEvent("stream.caption.segment.published", d, m, { content: firstString([d?.content]), timestamp_ms: asInt(d?.timestampMs), duration_ms: asInt(d?.durationMs), sentence_id: firstString([d?.sentenceId]), sequence_id: firstString([d?.sequenceId]), definite: asBool(d?.definite, false) }),
    imDelete: (d, m) => mapImDeleteEvent(d, m),
    inRoomBanner: (d, m) => buildEvent("stream.banner.in_room.updated", d, m, {
      banner_state: "updated",
      json_data: firstString([d?.jsonData]),
    }),
    rankUpdate: (d, m) => buildEvent("audience.rank.updated", d, m, { group_type: scalar(d?.groupType), priority: asInt(d?.priority) }),
    pollMessage: (d, m) => buildEvent("interaction.poll.updated", d, m, { poll_id: firstString([d?.pollId]), message_type: scalar(d?.messageType), poll_kind: scalar(d?.pollKind) }),
    rankText: (d, m) => buildEvent("audience.rank.text.updated", d, m, {
      scene: scalar(d?.scene),
      self_badge_pattern: displayPattern(d?.selfGetBadgeMsg),
      other_badge_pattern: displayPattern(d?.otherGetBadgeMsg),
      owner_idx_before_update: asInt(d?.ownerIdxBeforeUpdate),
      owner_idx_after_update: asInt(d?.ownerIdxAfterUpdate),
      cur_user_id: firstString([d?.curUserId]),
    }),
    linkMicBattlePunishFinish: (d, m) => buildEvent(
      "competition.link_mic_battle.punishment.finished",
      d,
      m,
      {
        battle_id: firstString([d?.battleId]),
        channel_id: firstString([d?.channelId]),
        operator_user_id: firstString([d?.opUid]),
        reason_code: scalar(d?.reason),
        battle_start_time_ms: asInt(d?.battleSettings?.startTimeMs),
        battle_end_time_ms: asInt(d?.battleSettings?.endTimeMs),
      },
      ["battle_id", "channel_id"],
    ),
    linkMicBattleTask: (d, m) => { const u = asObject(d?.taskUpdate, {}); const s = asObject(d?.taskSettle, {}); const r = asObject(d?.rewardSettle, {}); return buildEvent("competition.link_mic_battle.task.updated", d, m, { battle_id: firstString([d?.battleId]), task_message_type: scalar(d?.battleTaskMessageType), task_progress: asNum(u.taskProgress ?? u.progress ?? s.taskProgress), from_user_id: firstString([u.fromUserId, s.fromUserId]), task_result: scalar(s.taskResult ?? s.result), reward_status: scalar(r.status) }, ["battle_id", "task_message_type"]); },
    linkMicFanTicketMethod: (d, m) => {
      const n = asObject(d?.FanTicketRoomNotice, {});
      const fanTicketUsers = normalizeFanTicketUsers(n);
      const firstUserEntry = asObject(asEntriesArray(n?.UserFanTicketList)[0], {});
      const firstUser = asObject(firstUserEntry?.User ?? firstUserEntry?.user, {});
      return buildEvent("audience.fan_club.fan_level", d, m, {
        fan_level: extractFanLevel(d),
        notice_type: firstString([n.noticeType, n.type, d?.method]) || "updated",
        total_link_mic_fan_ticket: asInt(n?.TotalLinkMicFanTicket),
        top_user_fan_ticket: asInt(firstUserEntry?.FanTicket),
        top_user_id: firstString([firstUser?.userId, firstUser?.uid, firstUser?.id, firstUserEntry?.UserId, fanTicketUsers?.[0]?.user_id]),
        top_user_nickname: firstString([firstUser?.nickname, firstUser?.displayName]),
        fan_ticket_users: fanTicketUsers,
        ...buildUserPayload(d, m),
      });
    },
    linkMicMethod: (d, m) => buildEvent("competition.link_mic.session.updated", d, m, {
      message_type: scalar(d?.messageType),
      sub_type: scalar(d?.subType),
      channel_id: firstString([d?.channelId]),
      user_id: firstString([d?.userId]),
      invite_uid: firstString([d?.inviteUid]),
      duration: asNum(d?.duration),
      match_type: scalar(d?.matchType),
      win: asBool(d?.win, false),
    }),
    unauthorizedMember: (d, m) => buildEvent("moderation.member.unauthorized", d, m, { action: scalar(d?.action), nickname: firstString([d?.nickName]) }),
    oecLiveShopping: (d, m) => { const s = asObject(d?.shopData, {}); return buildEvent("commerce.live.shopping.updated", d, m, { shop_data: firstString([s.title, d?.data1]), detail_count: asArray(d?.details).length }); },
    msgDetect: (d, m) => buildEvent("diagnostics.message.detected", d, m, { detect_type: scalar(d?.detectType), trigger_condition: scalar(d?.triggerCondition), trigger_by: scalar(d?.triggerBy), from_region: firstString([d?.fromRegion]) }),
    linkMessage: (d, m) => buildEvent("competition.link.message.updated", d, m, {
      message_type: scalar(d?.MessageType ?? d?.messageType),
      scene: scalar(d?.Scene ?? d?.scene),
      linker_id: firstString([d?.LinkerId, d?.linkerId]),
      expire_timestamp: asInt(d?.expireTimestamp),
      linked_users: normalizeLinkedUsers(d?.ListChangeContent?.linkedUsers ?? d?.linkedUsers ?? d?.LinkedUsers),
    }),
    roomVerify: (d, m) => buildEvent("stream.room.verification.updated", d, m, { action: scalar(d?.action), notice_type: scalar(d?.noticeType), close_room: asBool(d?.closeRoom, false) }),
    linkLayer: (d, m) => buildEvent("competition.link.layer.updated", d, m, {
      message_type: scalar(d?.messageType),
      channel_id: firstString([d?.channelId]),
      scene: scalar(d?.scene),
      source_type: scalar(d?.source),
      source: scalar(d?.source),
      leave_user_id: firstString([d?.leaveContent?.leaver?.userId]),
      leave_reason: firstString([d?.leaveContent?.leaveReason]),
      kickout_user_id: firstString([d?.kickOutContent?.offliner?.userId]),
      kickout_reason: scalar(d?.kickOutContent?.kickoutReason),
      cohost_user_infos: normalizeCohostUserInfos(d?.businessContent?.cohostContent?.listChangeBizContent?.userInfos),
      business_content: asObject(d?.businessContent, d?.businessContent),
    }),
    roomPin: (d, m) => { const act = parsePinAction(d?.action); const mid = firstString([d?.pinId, d?.common?.msgId]); if (!mid) return null; if (act === "pin") return buildEvent("moderation.message.pin", d, m, { message_id: mid, sticky_length: Math.max(1, asInt(d?.displayDuration, asInt(d?.pinTime, 1))) }, ["message_id", "sticky_length"]); if (act === "unpin") return buildEvent("moderation.message.unpin", d, m, { message_id: mid }, ["message_id"]); return null; },
    superFan: (d, m) => { const c = asObject(d?.content, {}); return buildEvent("monetization.subscription.superfan", d, m, { subscription_type: "superfan", message_text: firstString([c.defaultPattern, c.text]), user_displayname: displayName(extractAuthorIdentity(d, m)) }, ["subscription_type"]); },
  };
}

function createTikTokLiveConnector() {
  return {
    id: "tiktok-live",
    platform: "tiktok",
    create() {
      let connection = null;
      async function disconnect() {
        if (!connection) return;
        const active = connection;
        connection = null;
        try { active.removeAllListeners(); } catch {}
        try { await active.disconnect(); } catch {}
      }

      async function connect(rawConfig, emit) {
        await disconnect();
        const connector = getConnectorModule();
        if (!connector) throw new Error("Biblioteca TikTok-Live-Connector nao esta disponivel.");
        if (typeof emit !== "function") throw new Error("Connector emit callback e obrigatorio.");

        const { TikTokLiveConnection, WebcastEvent, ControlEvent } = connector;
        const cfg = asObject(rawConfig, {});
        const uniqueId = normalizeUniqueId(cfg.uniqueId);
        if (!uniqueId) throw new Error("Defina o @usuario da live do TikTok para conectar.");
        const authorMode = compactString(cfg.authorMode) === "display-name" ? "display-name" : "username";
        const verboseRawEventLogger = createVerboseRawEventLogger({
          enabled: cfg.verbose,
          logPath: cfg.verboseLogPath,
          uniqueId,
          authorMode,
        });
        const mappers = buildMappers();
        let lastConnectErrorSig = "";
        let lastConnectErrorAt = 0;

        if (verboseRawEventLogger.enabled) {
          // eslint-disable-next-line no-console
          console.log(`[tiktok-live][verbose] raw connector events log path: ${verboseRawEventLogger.logPath}`);
        }

        const diagnostic = (code, message) => emit({ type: "error", at: Date.now(), fatal: false, code, message, suppressStream: true });
        const emitConnectError = (err) => {
          const message = formatConnectError(err);
          const sig = message.trim().toLowerCase();
          const now = Date.now();
          if (sig && sig === lastConnectErrorSig && now - lastConnectErrorAt < 2000) return message;
          lastConnectErrorSig = sig;
          lastConnectErrorAt = now;
          emit({ type: "error", at: now, fatal: false, code: "tiktok.connect.error", message });
          return message;
        };

        emit({ type: "lifecycle", at: Date.now(), state: "connecting" });
        const candidate = new TikTokLiveConnection(uniqueId, {
          processInitialData: !!cfg.processInitialData,
          disableEulerFallbacks: true,
        });
        connection = candidate;

        candidate.on(ControlEvent.CONNECTED, (state) => {
          if (connection !== candidate) return;
          verboseRawEventLogger.writeConnectorEvent(ControlEvent.CONNECTED, state, "control");
          emit({ type: "lifecycle", at: Date.now(), state: "connected", roomId: asString(state?.roomId, "") || null });
        });
        candidate.on(ControlEvent.DISCONNECTED, (event) => {
          if (connection !== candidate) return;
          verboseRawEventLogger.writeConnectorEvent(ControlEvent.DISCONNECTED, event, "control");
          connection = null;
          emit({ type: "lifecycle", at: Date.now(), state: "disconnected", reason: asString(event?.reason, "") });
        });
        candidate.on(ControlEvent.ERROR, (err) => {
          if (connection !== candidate) return;
          verboseRawEventLogger.writeConnectorEvent(ControlEvent.ERROR, err, "control");
          emitConnectError(err);
        });

        const registered = new Set(Object.values(asObject(WebcastEvent, {})).map((x) => compactString(x)).filter(Boolean));
        for (const eventName of registered) {
          candidate.on(eventName, (payload) => {
            if (connection !== candidate) return;
            verboseRawEventLogger.writeConnectorEvent(eventName, payload, "webcast");
            const mapper = mappers[eventName];
            if (typeof mapper !== "function") {
              diagnostic("tiktok.webcast.unmapped_event", `Webcast event '${eventName}' nao mapeado. Evento descartado.`);
              return;
            }
            let mapped = null;
            try {
              mapped = mapper(payload, authorMode);
            } catch (err) {
              diagnostic("tiktok.webcast.mapping_error", `Falha ao mapear '${eventName}': ${extractErrorText(err) || "erro desconhecido"}.`);
              return;
            }
            if (!mapped) {
              console.log("Unmapped payload for event", eventName, payload);
              diagnostic("tiktok.webcast.invalid_payload", `Webcast event '${eventName}' sem payload canonico valido. Evento descartado.`);
              return;
            }
            emit(mapped);
          });
        }

        try {
          const state = await candidate.connect();
          if (connection !== candidate) {
            try { await candidate.disconnect(); } catch {}
            return;
          }
          emit({ type: "lifecycle", at: Date.now(), state: "connected", roomId: asString(state?.roomId, "") || null });
        } catch (err) {
          if (connection === candidate) connection = null;
          const message = emitConnectError(err);
          emit({ type: "lifecycle", at: Date.now(), state: "disconnected", reason: message });
          throw new Error(message);
        }
      }

      return { connect, disconnect };
    },
  };
}

module.exports = {
  createTikTokLiveConnector,
  __test: {
    createVerboseRawEventLogger,
    resolveVerboseLogPath,
    serializeForLog,
    mapImDeleteEvent,
    normalizeBattleItems,
    mapLinkMicArmiesEvent,
    buildMappers,
  },
};
