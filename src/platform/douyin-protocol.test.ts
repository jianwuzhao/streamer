import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import protobuf from 'protobufjs/minimal.js'
import { decodeDouyinPacket, douyinNetworkRoom, douyinRoomUrl } from './douyin-protocol.ts'

const { Writer } = protobuf
const room = '7583227267035780096'
const web = 'https://live.douyin.com/12345'
const stamp = Date.now()
const user = Writer.create().uint32(8).uint64('7901234567834210001').uint32(26).string('测试观众').finish()

function message(method: string, userField: number, id: number, fill?: (body: InstanceType<typeof Writer>) => void, roomId = room) {
  const common = Writer.create().uint32(24).uint64(roomId).uint32(32).uint64(stamp).finish()
  const body = Writer.create().uint32(10).bytes(common).uint32(userField * 8 + 2).bytes(user)
  fill?.(body)
  return Writer.create().uint32(10).string(method).uint32(18).bytes(body.finish())
    .uint32(24).uint64(`7566091301410320${id.toString().padStart(3, '0')}`).finish()
}

test('抖音 WebSocket 和轮询解码七类互动，保留 64 位 ID 并过滤其他房间', () => {
  const gift = Writer.create().uint32(80).uint32(1).uint32(130).string('鲜花').finish()
  const items = [
    message('WebcastChatMessage', 2, 1, (body) => body.uint32(26).string('你好主播')),
    message('WebcastGiftMessage', 7, 2, (body) => body.uint32(16).uint32(5).uint32(40).uint32(6)
      .uint32(72).uint32(1).uint32(88).uint32(79).uint32(122).bytes(gift)),
    message('WebcastLikeMessage', 5, 3, (body) => body.uint32(16).uint32(3)),
    message('WebcastMemberMessage', 2, 4),
    message('WebcastSocialMessage', 2, 5, (body) => body.uint32(32).uint32(1)),
    message('WebcastFansclubMessage', 4, 6, (body) => body.uint32(16).uint32(2)),
    message('WebcastSocialMessage', 2, 7, (body) => body.uint32(32).uint32(2)),
    message('WebcastChatMessage', 2, 8, (body) => body.uint32(26).string('其他直播间'), '999999'),
    message('WebcastRoomStatsMessage', 2, 9),
  ]
  const response = Writer.create()
  for (const item of items) response.uint32(10).bytes(item)
  const body = response.finish()
  const frame = Writer.create().uint32(58).string('pb').uint32(66).bytes(gzipSync(body)).finish()
  const decoded = decodeDouyinPacket(frame, 'socket', room, web)
  assert.deepEqual(decoded, decodeDouyinPacket(body, 'poll', room, web))
  assert.deepEqual(decoded.map((item) => item.kind), ['comment', 'gift', 'like', 'join', 'follow', 'fansclub', 'share'])
  assert.equal(decoded[0]?.id, `${room}:7566091301410320001`)
  assert.equal(decoded[0]?.viewerId, '7901234567834210001')
  assert.equal(decoded[0]?.sentAt, new Date(stamp).toISOString())
  assert.equal(decoded[1]?.groupComplete, true)
  assert.equal(decoded[1]?.text, '送出 鲜花 ×6')
  assert.equal(decoded[2]?.text, '点赞 ×3')
})

test('拒绝损坏和超限数据，只监听抖音互动端点', () => {
  assert.throws(() => decodeDouyinPacket(Buffer.from([0x42, 0xff]), 'socket', room, web))
  assert.throws(() => decodeDouyinPacket(Buffer.alloc(2_097_153), 'poll', room, web), /Oversize/)
  assert.equal(douyinRoomUrl(web + '?share=1#room'), web)
  assert.equal(douyinRoomUrl('https://live.douyin.com.evil.com/12345'), null)
  assert.equal(douyinNetworkRoom(`wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/?room_id=${room}`, 'socket'), room)
  assert.equal(douyinNetworkRoom(`https://live.douyin.com/webcast/im/fetch/?room_id=${room}`, 'poll'), room)
  assert.equal(douyinNetworkRoom(`https://live.douyin.com/webcast/room/enter/?room_id=${room}`, 'poll'), null)
})
