// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import connectorPackage from "../src/connectors/tiktok-live-connector.cjs";

const { __test } = connectorPackage;
const tempDirs = [];

function createTempPath(fileName = "verbose.log") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-connector-test-"));
  tempDirs.push(dir);
  return path.join(dir, fileName);
}

function parseVerboseLine(line) {
  const text = String(line || "");
  const splitAt = text.indexOf(" ");
  if (splitAt <= 0) {
    throw new Error(`invalid verbose line: ${text}`);
  }
  return {
    timestamp: text.slice(0, splitAt),
    record: JSON.parse(text.slice(splitAt + 1)),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("tiktok connector verbose raw event log", () => {
  it("writes raw webcast/control events as timestamped raw lines", () => {
    const logPath = createTempPath();
    const logger = __test.createVerboseRawEventLogger({
      enabled: true,
      logPath,
    });

    logger.writeConnectorEvent("chat", { comment: "hello", value: 1 }, "webcast");
    logger.writeConnectorEvent("CONNECTED", { roomId: "123" }, "control");

    const rows = fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(parseVerboseLine);

    expect(rows).toHaveLength(2);
    expect(Number.isNaN(Date.parse(rows[0].timestamp))).toBe(false);
    expect(rows[0].record.source).toBe("webcast");
    expect(rows[0].record.event).toBe("chat");
    expect(rows[0].record.raw).toEqual({ comment: "hello", value: 1 });

    expect(Number.isNaN(Date.parse(rows[1].timestamp))).toBe(false);
    expect(rows[1].record.source).toBe("control");
    expect(rows[1].record.event).toBe("CONNECTED");
    expect(rows[1].record.raw).toEqual({ roomId: "123" });
  });

  it("does not write file when verbose logger is disabled", () => {
    const logPath = createTempPath();
    const logger = __test.createVerboseRawEventLogger({
      enabled: false,
      logPath,
    });

    logger.writeConnectorEvent("chat", { comment: "hidden" }, "webcast");
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("uses tiktok-live-connector.log as default verbose filename", () => {
    const resolvedPath = __test.resolveVerboseLogPath("");
    expect(path.basename(resolvedPath)).toBe("tiktok-live-connector.log");
  });

  it("serializes circular values safely", () => {
    const payload = { key: "value" };
    payload.self = payload;

    const serialized = __test.serializeForLog(payload);
    expect(serialized.key).toBe("value");
    expect(serialized.self).toBe("[[circular]]");
  });

  it("maps imDelete fallback using common.msgId when deleteMsgIdsList is empty", () => {
    const mapped = __test.mapImDeleteEvent({
      common: {
        msgId: "7607462122562816776",
      },
      deleteMsgIdsList: [],
      deleteUserIdsList: ["7058658556346434566"],
    }, "username");

    expect(mapped).toBeTruthy();
    expect(mapped.type).toBe("protocol");
    expect(mapped.typeCode).toBe("moderation.message.delete");
    expect(mapped.payload.message_id).toBe("7607462122562816776");
  });

  it("normalizes linkMic battleItems into canonical battle_items payload", () => {
    const normalized = __test.normalizeBattleItems({
      "7333268400971826182": {
        anchorIdStr: "7333268400971826182",
        hostScore: "686",
        userArmy: [
          {
            userIdStr: "6893614668540871686",
            nickname: "Ana",
            score: "34",
            avatarThumb: {
              url: [
                "https://p16-sign-sg.tiktokcdn.com/tos-alisg-avt-0068/sample.webp",
              ],
            },
          },
        ],
      },
      "7175799697994269698": {
        anchorIdStr: "7175799697994269698",
        hostScore: 730,
        userArmy: [
          {
            userIdStr: "7412302855266288641",
            nickname: "Kung",
            score: 69,
          },
        ],
      },
    });

    expect(normalized).toEqual({
      "7333268400971826182": {
        anchor_id_str: "7333268400971826182",
        host_score: 686,
        user_army: [
          {
            score: 34,
            nickname: "Ana",
            user_id_str: "6893614668540871686",
            avatar_thumb: {
              url: ["https://p16-sign-sg.tiktokcdn.com/tos-alisg-avt-0068/sample.webp"],
            },
          },
        ],
      },
      "7175799697994269698": {
        anchor_id_str: "7175799697994269698",
        host_score: 730,
        user_army: [
          {
            score: 69,
            nickname: "Kung",
            user_id_str: "7412302855266288641",
          },
        ],
      },
    });
  });

  it("maps linkMicArmies event with battle_items in canonical payload", () => {
    const mapped = __test.mapLinkMicArmiesEvent({
      common: { msgId: "m-1", roomId: "r-1", createTime: "1771250863037" },
      battleId: "7607463530094971665",
      battleStatus: 1,
      channelId: "7607460696573430545",
      battleSettings: {
        startTimeMs: "1771250634321",
        endTimeMs: "1771250938814",
      },
      battleItems: {
        "7333268400971826182": {
          anchorIdStr: "7333268400971826182",
          hostScore: "686",
          userArmy: [
            { userIdStr: "6893614668540871686", nickname: "Ana", score: "34" },
          ],
        },
      },
    }, "username");

    expect(mapped).toBeTruthy();
    expect(mapped.typeCode).toBe("competition.link_mic_battle.points.updated");
    expect(mapped.payload.battle_id).toBe("7607463530094971665");
    expect(mapped.payload.battle_status).toBe(1);
    expect(mapped.payload.battle_start_time_ms).toBe(1771250634321);
    expect(mapped.payload.battle_end_time_ms).toBe(1771250938814);
    expect(mapped.payload.battle_items).toEqual({
      "7333268400971826182": {
        anchor_id_str: "7333268400971826182",
        host_score: 686,
        user_army: [
          { score: 34, nickname: "Ana", user_id_str: "6893614668540871686" },
        ],
      },
    });
  });

  it("enriches follow/share/social mappings with optional fields", () => {
    const mappers = __test.buildMappers();

    const follow = mappers.follow({
      action: "1",
      shareType: "0",
      followCount: "143151",
      shareCount: "3",
      common: { displayText: { defaultPattern: "{0:user} followed the LIVE creator" } },
      user: {
        userId: "7589796504895505428",
        uniqueId: "sayhmoncastelobra",
        nickname: "Sayhmon camisa10",
      },
    }, "username");

    const share = mappers.share({
      action: "3",
      shareType: "1",
      followCount: "0",
      shareCount: "87",
      common: { displayText: { defaultPattern: "{0:user} shared the LIVE" } },
      user: {
        userId: "6893614668540871686",
        uniqueId: "anamoraes595",
        nickname: "Ana Moraes",
      },
    }, "username");

    const social = mappers.social({
      action: "4",
      shareType: "0",
      shareCount: "0",
      followCount: "0",
      common: { displayText: { defaultPattern: "{0:user} reposted" } },
      user: {
        userId: "7572588618041541640",
        uniqueId: "elyn49776",
        nickname: "Ely",
      },
    }, "username");

    expect(follow.payload.followage_type).toBe("follow");
    expect(follow.payload.action).toBe("1");
    expect(follow.payload.share_type).toBe("0");
    expect(follow.payload.follow_count).toBe(143151);
    expect(follow.payload.share_count).toBe(3);
    expect(follow.payload.display_pattern).toBe("{0:user} followed the LIVE creator");

    expect(share.payload.reaction_type).toBe("share");
    expect(share.payload.action).toBe("3");
    expect(share.payload.share_type).toBe("1");
    expect(share.payload.share_count).toBe(87);
    expect(share.payload.display_pattern).toBe("{0:user} shared the LIVE");

    expect(social.payload.social_action).toBe("4");
    expect(social.payload.share_type).toBe("0");
    expect(social.payload.display_pattern).toBe("{0:user} reposted");
    expect(social.payload.user_displayname).toBe("Ely");
  });

  it("maps barrage event with level-up fields and barrage user identity", () => {
    const mappers = __test.buildMappers();
    const barrage = mappers.barrage({
      msgType: "10",
      subType: "super_fan_upgrade",
      content: {
        defaultPattern: "reached member Lv.{0:string}",
        piecesList: [{ stringValue: "23" }],
      },
      duration: "4000",
      scene: "0",
      commonBarrageContent: {
        piecesList: [
          {
            userValue: {
              user: {
                userId: "7198647403678761989",
                uniqueId: "3esmit",
                nickname: "Ricardo",
              },
            },
          },
        ],
      },
      fansLevelParam: {
        currentGrade: "23",
      },
      userGradeParam: {
        currentGrade: "31",
      },
    }, "username");

    expect(barrage.typeCode).toBe("audience.room_join");
    expect(barrage.payload.sub_type).toBe("super_fan_upgrade");
    expect(barrage.payload.msg_type).toBe("10");
    expect(barrage.payload.level_value).toBe("23");
    expect(barrage.payload.fan_level_current_grade).toBe(23);
    expect(barrage.payload.user_level_current_grade).toBe(31);
    expect(barrage.payload.barrage_user_id).toBe("7198647403678761989");
    expect(barrage.payload.barrage_user_unique_id).toBe("3esmit");
    expect(barrage.payload.barrage_user_displayname).toBe("Ricardo");
    expect(barrage.payload.user_displayname).toBe("Ricardo");
  });

  it("maps link layer/message and fan ticket optional fields", () => {
    const mappers = __test.buildMappers();

    const linkMessage = mappers.linkMessage({
      MessageType: "2",
      Scene: "2",
      LinkerId: "7607460696573430545",
      expireTimestamp: "123456789",
      ListChangeContent: {
        linkedUsers: [
          {
            user: {
              userId: "6795583965186114566",
              uniqueId: "cabrito.ofcl",
              nickname: "CABRITO",
            },
            linkStatus: 1,
            userPosition: 0,
            linkType: 0,
          },
          {
            user: {
              userId: "7198647403678761989",
              uniqueId: "3esmit",
              nickname: "Ricardo",
            },
            linkStatus: 3,
            userPosition: 0,
            linkType: 0,
          },
        ],
      },
    }, "username");

    const linkLayer = mappers.linkLayer({
      messageType: "1",
      scene: "4",
      channelId: "7607432544237259527",
      source: "8",
      leaveContent: {
        leaver: {
          userId: "7198647403678761989",
        },
        leaveReason: "10003",
      },
      kickOutContent: {
        offliner: {
          userId: "700100200300",
        },
        kickoutReason: 2,
      },
      businessContent: {
        foo: "bar",
        value: 7,
        cohostContent: {
          listChangeBizContent: {
            userInfos: [
              {
                userId: "6795583965186114566",
                displayId: "cabrito.ofcl",
                nickname: "CABRITO",
                changeType: 1,
                linkStatus: 1,
                userPosition: 0,
              },
              {
                userId: "7198647403678761989",
                displayId: "3esmit",
                nickname: "Ricardo",
                changeType: 2,
                linkStatus: 3,
                userPosition: 0,
              },
            ],
          },
        },
      },
    }, "username");

    const fanTicket = mappers.linkMicFanTicketMethod({
      FanTicketRoomNotice: {
        TotalLinkMicFanTicket: "370",
        UserFanTicketList: [
          {
            FanTicket: "120",
            MatchRank: "1",
            UserId: "7001",
          },
          {
            FanTicket: "80",
            MatchRank: "2",
            User: {
              userId: "7002",
              nickname: "Top Fan",
            },
          },
        ],
      },
    }, "username");

    expect(linkMessage.payload.expire_timestamp).toBe(123456789);
    expect(linkMessage.payload.linked_users).toEqual([
      {
        user_id: "6795583965186114566",
        unique_id: "cabrito.ofcl",
        nickname: "CABRITO",
        link_status: 1,
        user_position: 0,
        link_type: 0,
      },
      {
        user_id: "7198647403678761989",
        unique_id: "3esmit",
        nickname: "Ricardo",
        link_status: 3,
        user_position: 0,
        link_type: 0,
      },
    ]);
    expect(linkLayer.payload.source).toBe("8");
    expect(linkLayer.payload.leave_user_id).toBe("7198647403678761989");
    expect(linkLayer.payload.leave_reason).toBe("10003");
    expect(linkLayer.payload.kickout_user_id).toBe("700100200300");
    expect(linkLayer.payload.kickout_reason).toBe(2);
    expect(linkLayer.payload.cohost_user_infos).toEqual([
      {
        user_id: "6795583965186114566",
        unique_id: "cabrito.ofcl",
        nickname: "CABRITO",
        change_type: 1,
        link_status: 1,
        user_position: 0,
      },
      {
        user_id: "7198647403678761989",
        unique_id: "3esmit",
        nickname: "Ricardo",
        change_type: 2,
        link_status: 3,
        user_position: 0,
      },
    ]);
    expect(linkLayer.payload.business_content).toMatchObject({ foo: "bar", value: 7 });
    expect(fanTicket.payload.total_link_mic_fan_ticket).toBe(370);
    expect(fanTicket.payload.top_user_fan_ticket).toBe(120);
    expect(fanTicket.payload.top_user_id).toBe("7001");
    expect(fanTicket.payload.fan_ticket_users).toEqual([
      { user_id: "7001", fan_ticket: 120, match_rank: 1 },
      { user_id: "7002", fan_ticket: 80, match_rank: 2 },
    ]);
  });
});
