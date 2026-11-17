import { gunzipSync } from 'node:zlib'
import protobuf from 'protobufjs/minimal.js'
import type { DanmakuMessage, InteractionKind } from '../live/conversation.ts'

// Wire fields from DouyinBarrageGrab/BarrageGrab/proto/message.proto and
// opedium/douyin-live-proto. Keep 64-bit IDs as decimal strings.
const { Reader } = protobuf
const MAX_PACKET = 2 * 1024 * 1024
type Field = Uint8Array | string
type Fields = Map<number, Field[]>

function fields(bytes: Uint8Array): Fields {
  const reader = Reader.create(bytes)
  const result: Fields = new Map()
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const id = tag >>> 3
    const wire = tag & 7
    if (!id || (wire !== 0 && wire !== 1 && wire !== 2 && wire !== 5)) throw new Error('Invalid protobuf tag')
    if (wire !== 0 && wire !== 2) {
      reader.skipType(wire)
      continue
    }
    const value = wire === 0 ? reader.uint64().toString() : reader.bytes()
    const list = result.get(id)
    if (list) list.push(value)
    else result.set(id, [value])
  }
  return result
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
function text(data: Fields, field: number): string {
  const value = data.get(field)?.at(-1)
  return value instanceof Uint8Array ? utf8.decode(value) : value ?? ''
}
function nested(data: Fields, field: number): Fields {
  const value = data.get(field)?.at(-1)
  return value instanceof Uint8Array ? fields(value) : new Map()
}
function id(data: Fields, field: number): string {
  const value = text(data, field)
  return /^[1-9]\d{0,19}$/.test(value) ? value : ''
}
function count(data: Fields, field: number): number {
  return Math.min(1_000_000, Number(id(data, field) || 1))
}

export function douyinRoomUrl(raw: string): string | null {
  const match = /^https:\/\/live\.douyin\.com\/([A-Za-z0-9_-]{1,80})\/?(?:\?[^#\s]*)?(?:#[^\s]*)?$/.exec(raw.trim())
  return match ? `https://live.douyin.com/${match[1]}` : null
}

export function douyinNetworkRoom(raw: string, transport: 'socket' | 'poll'): string | null {
  if (!URL.canParse(raw)) return null
  const url = new URL(raw)
  if (transport === 'socket') {
    if (url.protocol !== 'wss:' ||
      !/^(?:webcast|webcast\d+-ws-web-[a-z0-9]+)\.douyin\.com$/.test(url.hostname) ||
      !url.pathname.startsWith('/webcast/im/')) return null
  } else if (url.protocol !== 'https:' || !['live.douyin.com', 'webcast.douyin.com'].includes(url.hostname) ||
    !/^\/webcast\/im\/fetch\/?$/.test(url.pathname)) return null
  const room = url.searchParams.get('room_id') ?? url.searchParams.get('roomId')
  return room && /^[1-9]\d{0,19}$/.test(room) ? room : null
}

function unwrap(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_PACKET) throw new Error('Oversize Douyin packet')
  return bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes, { maxOutputLength: MAX_PACKET }) : bytes
}

function timestamp(value: string, receivedAt: number): string {
  const raw = Number(value)
  const ms = raw > 0 && raw < 1e11 ? raw * 1000 : raw
  return new Date(ms > 0 && ms < 8.64e15 ? ms : receivedAt).toISOString()
}

export function decodeDouyinPacket(
  bytes: Uint8Array,
  transport: 'socket' | 'poll',
  internalRoom: string,
  roomId: string,
  receivedAt = Date.now(),
): DanmakuMessage[] {
  let payload = unwrap(bytes)
  if (transport === 'socket') {
    const frame = fields(payload)
    const type = text(frame, 7)
    if (type === 'hb' || type === 'ack' || type === 'pong') return []
    const body = frame.get(8)?.at(-1)
    if (!(body instanceof Uint8Array)) throw new Error('Missing Douyin frame payload')
    payload = unwrap(body)
  }
  const batch = fields(payload)
  const result: DanmakuMessage[] = []
  for (const item of (batch.get(1) ?? []).slice(0, 1000)) {
    if (!(item instanceof Uint8Array)) continue
    const envelope = fields(item)
    const method = text(envelope, 1)
    const userField = ({
      WebcastChatMessage: 2, WebcastGiftMessage: 7, WebcastLikeMessage: 5,
      WebcastMemberMessage: 2, WebcastSocialMessage: 2, WebcastFansclubMessage: 4,
    } as Record<string, number>)[method]
    if (typeof userField !== 'number') continue
    const data = nested(envelope, 2)
    const common = nested(data, 1)
    const messageRoom = id(common, 3)
    const eventId = id(envelope, 3) || id(common, 2)
    if (!eventId || (messageRoom && messageRoom !== internalRoom)) continue
    const user = nested(data, userField)
    const viewer = id(user, 1) || (method === 'WebcastMemberMessage' ? id(data, 12) : '')
    const nickname = text(user, 3).trim().slice(0, 40)
    let kind: InteractionKind
    let content: string
    let quantity: number | undefined
    let group: string | undefined
    let groupComplete = false
    let giftName: string | undefined
    switch (method) {
      case 'WebcastChatMessage':
        kind = 'comment'
        content = text(data, 3).trim().slice(0, 500)
        break
      case 'WebcastGiftMessage': {
        kind = 'gift'
        const gift = nested(data, 15)
        giftName = text(gift, 16).trim().slice(0, 40) || '礼物'
        quantity = Math.max(count(data, 4), count(data, 5), count(data, 6))
        const groupId = id(data, 11)
        if (viewer && groupId && (id(gift, 10) || quantity > 1 || id(data, 9))) {
          group = `${viewer}:${id(data, 2)}:${groupId}`
          groupComplete = id(data, 9) === '1'
        }
        content = `送出 ${giftName} ×${quantity}`
        break
      }
      case 'WebcastLikeMessage':
        kind = 'like'
        quantity = count(data, 2)
        content = `点赞 ×${quantity}`
        break
      case 'WebcastMemberMessage':
        kind = 'join'
        content = '进入直播间'
        break
      case 'WebcastFansclubMessage':
        kind = 'fansclub'
        content = ({ '1': '粉丝团等级提升', '2': '加入粉丝团' })[id(data, 2)] ?? '粉丝团互动'
        break
      default: {
        const action = id(data, 4)
        if (action !== '1' && action !== '2') continue
        kind = action === '1' ? 'follow' : 'share'
        content = kind === 'follow' ? '关注了主播' : '分享了直播间'
      }
    }
    if (!content) continue
    result.push({
      id: `${internalRoom}:${eventId}`, roomId, kind, text: content,
      sentAt: timestamp(id(common, 4) || id(batch, 4), receivedAt),
      ...(nickname ? { nickname } : {}),
      ...(viewer ? { viewerId: viewer } : {}),
      ...(quantity === undefined ? {} : { quantity }),
      ...(group ? { group, groupComplete } : {}),
      ...(giftName ? { giftName } : {}),
    })
  }
  return result
}
