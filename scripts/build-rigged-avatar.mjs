import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { fitDeskSleeves } from './fit-xiaxia-desk-sleeves.mjs'

// This model uses geometry and materials only, so the exporter only needs
// FileReader's Blob-to-ArrayBuffer operation when run from Node.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result
      this.onloadend?.()
    })
  }
}

const scene = new THREE.Scene()
const standard = (color, roughness = .76) => new THREE.MeshStandardMaterial({ color, roughness })
const materials = {
  skin: standard(0xecbcaa, .68),
  knit: standard(0xeee6dd, .87),
  denim: standard(0xb2a9a0, .92),
  hair: standard(0x64472f, .56),
  hairShade: standard(0x443022, .7),
  headset: standard(0xe4dde0, .28),
  mic: standard(0xcfadc6, .56),
  hand: new THREE.MeshStandardMaterial({ color: 0xe0b5aa, roughness: .61, vertexColors: true }),
  sleeve: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
  portrait: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, alphaTest: .03 }),
}
const sphere = new THREE.SphereGeometry(1, 32, 20)
const bones = []
const skins = new Map()
const skinGeometries = []
const bone = (name, parent, x, y, z) => {
  const joint = new THREE.Bone()
  joint.name = name
  joint.position.set(x, y, z)
  parent.add(joint)
  bones.push(joint)
  return joint
}
const rigid = (parent, mat, x, y, z, sx, sy, sz, geometry = sphere) => {
  const mesh = new THREE.Mesh(geometry, materials[mat])
  mesh.position.set(x, y, z)
  mesh.scale.set(sx, sy, sz)
  parent.add(mesh)
  return mesh
}
const skin = (joint, material, x, y, z, sx, sy, sz) => {
  const geometry = sphere.clone().scale(sx, sy, sz).translate(x, y, z)
  const entries = skins.get(material) ?? []
  entries.push({ joint, geometry })
  skins.set(material, entries)
}

const hips = bone('Hips', scene, 0, .74, 0)
const spine = bone('Spine', hips, 0, .24, 0)
const head = bone('Head', spine, 0, .490, 0)

function torsoShell(parent, mat, rings, neckline = 0) {
  const vertices = [], indices = []
  const count = 56
  for (let j = 0; j < rings.length; j++) {
    const [y, rx, rz, z] = rings[j]
    for (let i = 0; i < count; i++) {
      const theta = 2 * Math.PI * i / count
      const front = Math.max(0, Math.cos(theta))
      const dip = neckline * front ** 2 * (j / (rings.length - 1)) ** 3
      vertices.push(Math.sin(theta) * rx, y - dip, z + Math.cos(theta) * rz)
      if (j) {
        const a = (j - 1) * count + i
        const b = (j - 1) * count + (i + 1) % count
        const c = b + count
        indices.push(a, b, c, a, c, a + count)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, materials[mat])
  parent.add(mesh)
}

skin(hips, 'denim', 0, .063, 0, .242, .126, .151)
torsoShell(spine, 'skin', [
  [-.18, .183, .102, -.007], [-.10, .164, .106, -.004], [.02, .156, .100, .007], [.10, .174, .118, .010],
  [.20, .202, .143, .021], [.27, .218, .131, .010], [.34, .220, .109, .006],
  [.395, .181, .091, -.007], [.434, .091, .078, -.004], [.472, .067, .068, .005], [.516, .063, .064, .006],
])
torsoShell(spine, 'knit', [
  [-.096, .170, .100, -.045], [-.075, .168, .103, -.045], [.02, .161, .102, -.042],
  [.11, .183, .131, .020], [.20, .210, .150, .028], [.27, .206, .139, .016],
  [.317, .192, .120, .009], [.342, .177, .108, .006],
], .158)

const strand = (parent, mat, points, radius) => {
  const path = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, 28, radius, 9, false), materials[mat])
  parent.add(mesh)
  return mesh
}

// The visible face, fringe and headset are calibrated in the source portrait's
// pixel coordinates, then placed on a curved head. No room pixels are used.
const faceScale = .00148
const fromPortrait = (x, y, z) => new THREE.Vector3((x - 395) * faceScale, 1.47 + (515 - y) * faceScale, z)
function depth(x, y) {
  const side = (x - 395) / 199
  const vertical = (y - 310) / 264
  const nose = .018 * Math.exp(-(((x - 399) / 42) ** 2) - ((y - 386) / 35) ** 2)
  return .061 + .109 * Math.sqrt(Math.max(0, 1 - side * side - .65 * vertical * vertical)) + nose
}
const toHead = (x, y) => [(x - 395) * faceScale, (515 - y) * faceScale, depth(x, y)]

// Left/right limits run just inside the head outline. The mic boom is a
// separate tube, so the chair visible inside its opening stays in the scene.
const outline = [
  [81, 324, 344], [88, 297, 356], [103, 277, 368], [120, 260, 376], [136, 247, 388],
  [147, 239, 476], [164, 232, 496], [187, 228, 508], [213, 222, 520], [242, 218, 532],
  [267, 219, 543], [292, 219, 553], [317, 217, 555], [350, 214, 546], [377, 212, 535],
  [399, 214, 525], [416, 213, 493], [443, 211, 471], [462, 207, 453], [479, 204, 449],
  [505, 201, 465], [531, 196, 492], [547, 193, 508],
]
function portraitGeometry(outline, project, { fadeIn = 9, fadeOut = 18, edgeFade = 6, divisions = 72, step = 4 } = {}) {
  const geometry = new THREE.BufferGeometry()
  const points = [], uvs = [], colors = [], triangles = []
  let row = 0
  let segment = 0
  const minY = outline[0][0], maxY = outline.at(-1)[0]
  const lastRow = Math.ceil((maxY - minY) / step)
  for (; row <= lastRow; row++) {
    const y = Math.min(maxY, minY + row * step)
    while (y > outline[segment + 1][0]) segment++
    const [y1, l1, r1] = outline[segment]
    const [y2, l2, r2] = outline[segment + 1]
    const blend = (y - y1) / (y2 - y1)
    const left = THREE.MathUtils.lerp(l1, l2, blend)
    const right = THREE.MathUtils.lerp(r1, r2, blend)
    for (let col = 0; col <= divisions; col++) {
      const ratio = col / divisions
      const x = THREE.MathUtils.lerp(left, right, ratio)
      const { position, textureY = y } = project(x, y, ratio)
      points.push(...position)
      uvs.push(x / 768, textureY / 1080)
      const fade = edgeFade ? Math.min(1, (x - left) / edgeFade, (right - x) / edgeFade) : 1
      colors.push(1, 1, 1, Math.max(0, Math.min(fade, (y - minY) / fadeIn, fadeOut ? (maxY - y) / fadeOut : 1)))
      if (row && col) {
        const bottomRight = row * (divisions + 1) + col
        const topRight = bottomRight - divisions - 1
        triangles.push(topRight - 1, bottomRight - 1, topRight, topRight, bottomRight - 1, bottomRight)
      }
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setIndex(triangles)
  geometry.computeVertexNormals()
  return geometry
}

const faceGeometry = portraitGeometry(outline, (x, y) => ({ position: toHead(x, y) }), { fadeIn: 6, fadeOut: 25 })
const points = faceGeometry.attributes.position.array
const uvs = faceGeometry.attributes.uv.array
faceGeometry.morphTargetsRelative = true
const gauss = (x, y) => Math.exp(-(x * x + y * y))
faceGeometry.morphAttributes.position = ['blinkLeft', 'blinkRight'].map((name, channel) => {
  const delta = new Float32Array(points.length)
  for (let i = 0; i < points.length / 3; i++) {
    const x = uvs[i * 2] * 768
    const y = uvs[i * 2 + 1] * 1080
    const cx = channel === 0 ? 351 : 441
    delta[i * 3 + 1] = (y - 347) * faceScale * .95 * gauss((x - cx) / 30, (y - 347) / 15)
  }
  const attr = new THREE.BufferAttribute(delta, 3)
  attr.name = name
  return attr
})
const faceMaterial = materials.portrait.clone()
faceMaterial.name = 'FacePortrait'
const front = new THREE.Mesh(faceGeometry, faceMaterial)
front.name = 'PhotoFace'
front.renderOrder = 1
head.add(front)

// Volume and silhouette for the back of the head, hair and earcups.
rigid(head, 'hairShade', -.026, .302, -.052, .170, .245, .126)
rigid(head, 'hair', -.126, .523, -.056, .070, .080, .106)
for (const sign of [-1, 1]) {
  const ear = rigid(head, 'headset', sign * .203, .243, .018, .033, .089, .079)
  ear.rotation.z = sign * .14
}
// The bodice is a second, convex surface bound to the spine. Its UVs stay
// inside the torso and the hair resting over it, away from the moving sleeves.
const bodice = portraitGeometry([
  [489, 198, 473], [507, 190, 535], [526, 183, 581], [550, 188, 588], [585, 187, 590],
  [625, 188, 598], [674, 185, 599], [713, 181, 605], [773, 174, 617],
  [819, 172, 636], [873, 170, 649], [932, 161, 681], [984, 151, 711],
  [1034, 145, 734], [1062, 143, 745],
], (x, y, ratio) => {
  const neckline = THREE.MathUtils.smoothstep(y, 525, 660)
  const center = Math.sqrt(Math.max(0, 1 - (2 * ratio - 1) ** 2))
  const front = .020 + .123 * center + neckline * (.032 + .042 * center)
  return { position: [(x - 395) * faceScale, .490 + (515 - y) * faceScale, front] }
}, { fadeIn: 25, fadeOut: 12 })
const torso = new THREE.Mesh(bodice, materials.portrait)
torso.name = 'PhotoTorso'
torso.renderOrder = 1
spine.add(torso)
strand(head, 'headset', [[.193,.220,.125], [.165,.159,.148], [.134,.103,.164], [.090,.066,.172]], .004)
rigid(head, 'mic', .091, .064, .173, .010, .006, .007)

const sleeves = [
  {
    side: 'L', sign: -1, joints: [[183, 553, .042], [115, 790, .092], [96, 993, .320]], rows: [
      [520, 159, 208], [542, 146, 207], [569, 126, 210], [606, 105, 213], [646, 94, 209],
      [686, 82, 203], [725, 71, 195], [763, 58, 185], [800, 21, 177], [838, 1, 173],
      [870, 0, 170], [907, 0, 167], [945, 0, 160], [977, 0, 151], [1000, 4, 149],
    ],
  }, {
    side: 'R', sign: 1, joints: [[588, 550, .041], [655, 795, .093], [827, 995, .309]], rows: [
      [515, 570, 598], [540, 583, 631], [572, 587, 661], [604, 589, 676], [648, 588, 690],
      [687, 589, 705], [725, 593, 720], [760, 605, 738], [799, 619, 770], [846, 639, 800],
      [900, 653, 811], [946, 683, 818], [984, 705, 819], [1019, 727, 816],
    ],
  },
]

function makeSleeve(outline, start, hinge, wrist, landmarks, jointIndices) {
  const slices = 48
  const positions = [], uvs = [], colors = [], indices = [], joints = [], weights = []
  const [shoulderY, elbowY, wristY] = landmarks.map((point) => point[1])
  const firstY = outline[0][0], lastY = outline.at(-1)[0]
  const steps = Math.ceil((lastY - firstY) / 5)
  const forearm = wrist.clone().sub(hinge).normalize()
  const cross = new THREE.Vector3(0, 0, 1).cross(forearm).normalize()
  const front = forearm.clone().cross(cross).normalize()
  const position = new THREE.Vector3(), ring = new THREE.Vector3()
  let segment = 0

  for (let row = 0; row <= steps + 3; row++) {
    const y = Math.min(lastY, firstY + 5 * row)
    while (y > outline[segment + 1][0]) segment++
    const [y0, left0, right0] = outline[segment], [y1, left1, right1] = outline[segment + 1]
    const t = (y - y0) / (y1 - y0)
    const left = THREE.MathUtils.lerp(left0, left1, t), right = THREE.MathUtils.lerp(right0, right1, t)
    const drape = THREE.MathUtils.smoothstep(y, lastY - 82, lastY)
    const handFit = THREE.MathUtils.smoothstep(y, elbowY + 24, lastY - 64)
    const closure = Math.max(0, row - steps)
    const shoulderAnchor = 1 - THREE.MathUtils.smoothstep(y, shoulderY - 8, shoulderY + 102)
    const aroundElbow = THREE.MathUtils.smoothstep(y, elbowY - 71, elbowY + 67)
    const aroundWrist = [0, .18, .60, 1][closure]
    const far = y < elbowY ? start : wrist
    const farY = y < elbowY ? shoulderY : wristY
    const depth = THREE.MathUtils.lerp(hinge.z, far.z, THREE.MathUtils.clamp((y - elbowY) / (farY - elbowY), 0, 1))
    for (let i = 0; i < slices; i++) {
      const theta = i * Math.PI * 2 / slices
      const side = Math.sin(theta), face = Math.cos(theta)
      const photographedX = THREE.MathUtils.lerp(left, right, (side + 1) / 2)
      const fittedX = photographedX - side * (right - left) * .092 * handFit
      const hemY = y - drape * (10 - 16 * side * side)
      const rounded = depth + face * (face > 0 ? .062 : .047) * (1 - .09 * handFit)
      position.copy(fromPortrait(fittedX, hemY, rounded))
      // Keep the photographed drape on the arm and turn the sewn cuff into
      // the actual plane around the forearm, including its return edge.
      const offset = (y - lastY) / 82 * .132 - closure * .002
      ring.copy(wrist).addScaledVector(forearm, offset)
        .addScaledVector(cross, side * (.056 - closure * .0105))
        .addScaledVector(front, face * (.038 - closure * .0063) - closure * .0021)
      position.lerp(ring, drape)
      positions.push(...position.toArray())
      // Sample inside the pictured fabric along the hem. The next texels
      // belong to the resting hand and would otherwise move with the jacket.
      const clothY = Math.min(hemY - 3 * closure, wristY - 22 + 9 * side * side)
      uvs.push(Math.min(767, photographedX) / 768, clothY / 1080)
      const shadow = 1 - .21 * THREE.MathUtils.smoothstep(-face, .12, 1) - closure * .025
      colors.push(shadow, shadow, shadow, 1)
      joints.push(...jointIndices)
      const moving = 1 - shoulderAnchor
      weights.push(shoulderAnchor, moving * (1 - aroundElbow), moving * aroundElbow * (1 - aroundWrist), moving * aroundElbow * aroundWrist)
      if (row) {
        const a = (row - 1) * slices + i, b = (row - 1) * slices + (i + 1) % slices
        indices.push(a, a + slices, b, b, a + slices, b + slices)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// The donor hand uses anatomical palms, an opposed thumb, and three joints
// per finger. Coordinates are wrist-local and the positive Z side is dorsal.
const handTemplate = JSON.parse(await readFile(new URL('./assets/xiaxia-hand.json', import.meta.url), 'utf8'))
const fingerNames = ['Finger', 'Tip', 'Distal']

function makeHand(wrist, side, sign) {
  const dorsal = new THREE.Vector3(0, 0, 1)
  // Fit in the wrist's own coordinates. The same proportions define the
  // surface and the joints, so lifting the arm cannot stretch the fingers.
  const toHand = ([x, y, z]) => {
    const along = -y
    const palm = THREE.MathUtils.smoothstep(along, .18, .62) * (1 - THREE.MathUtils.smoothstep(along, .92, 1.24))
    const handWidth = .105 + .011 * palm
    return new THREE.Vector3(-sign * x * handWidth, y * .104, z * (.104 + .010 * palm))
  }
  const wristPlacement = { bone: wrist, position: new THREE.Vector3(), rotation: new THREE.Quaternion() }
  const fitted = new Map([['wrist', wristPlacement]])
  const fit = (name) => {
    if (fitted.has(name)) return fitted.get(name)
    const [, parentName, head, tail] = handTemplate.bones.find(([id]) => id === name)
    const parent = fit(parentName)
    const position = toHand(head)
    const direction = position.clone().sub(toHand(tail)).normalize()
    const x = direction.clone().cross(dorsal).normalize()
    const z = x.clone().cross(direction).normalize()
    const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, direction, z))
    const match = /^finger([1-5])-([1-3])$/.exec(name)
    const jointName = match ? fingerNames[Number(match[2]) - 1] + side + (Number(match[1]) - 1) : name + side
    const parentInverse = parent.rotation.clone().invert()
    const offset = position.clone().sub(parent.position).applyQuaternion(parentInverse)
    const node = bone(jointName, parent.bone, offset.x, offset.y, offset.z)
    node.quaternion.copy(parentInverse).multiply(rotation)
    const result = { bone: node, position, rotation }
    fitted.set(name, result)
    return result
  }
  const jointIds = handTemplate.bones.map(([name]) => bones.indexOf(fit(name).bone))
  const positions = handTemplate.vertices.flatMap((point) => toHand(point).toArray())
  const indices = [], joints = [], weights = []
  const boundary = new Map()
  for (const source of handTemplate.faces) {
    const face = sign === 1 ? source.toReversed() : source
    for (let i = 1; i + 1 < face.length; i++) indices.push(face[0], face[i], face[i + 1])
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length]
      const key = Math.min(a, b) + ':' + Math.max(a, b)
      if (boundary.has(key)) boundary.delete(key)
      else boundary.set(key, [a, b])
    }
  }
  for (const list of handTemplate.weights) {
    const total = list.reduce((sum, entry, i) => sum + (i % 2 ? entry : 0), 0)
    for (let i = 0; i < 8; i += 2) {
      joints.push(jointIds[list[i] ?? 0])
      weights.push((list[i + 1] ?? 0) / total)
    }
  }
  // Close the cut forearm inside the cuff. All exposed fingers and the palm
  // retain the original shared vertices and original joint influence weights.
  const rim = [...new Set([...boundary.values()].flat())]
  const center = new THREE.Vector3()
  for (const i of rim) center.add(toHand(handTemplate.vertices[i]))
  center.multiplyScalar(1 / rim.length)
  positions.push(...center.toArray())
  joints.push(jointIds[0], 0, 0, 0)
  weights.push(1, 0, 0, 0)
  for (const [a, b] of boundary.values()) indices.push(b, a, handTemplate.vertices.length)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const normals = geometry.attributes.normal
  const colors = []
  for (let v = 0; v < handTemplate.vertices.length; v++) {
    const source = handTemplate.weights[v]
    const normalZ = normals.getZ(v)
    let nail = 0, crease = 0
    for (let i = 0; i < source.length; i += 2) {
      const [name, , head, tail] = handTemplate.bones[source[i]]
      const segment = /^finger([1-5])-([1-3])$/.exec(name)
      if (!segment) continue
      const start = toHand(head), end = toHand(tail)
      const forward = end.sub(start)
      const local = toHand(handTemplate.vertices[v]).sub(start)
      const progress = local.dot(forward) / forward.lengthSq()
      if (segment[2] === '3') {
        const lateral = forward.clone().normalize().cross(dorsal).normalize()
        const across = Math.abs(local.dot(lateral)) / [.0064, .0056, .0059, .0055, .0046][Number(segment[1]) - 1]
        const mask = THREE.MathUtils.smoothstep(progress, .15, .43) * (1 - THREE.MathUtils.smoothstep(progress, .85, 1.02))
        nail = Math.max(nail, mask * (1 - THREE.MathUtils.smoothstep(across, .44, 1)) * THREE.MathUtils.smoothstep(normalZ, .38, .88))
      } else if (segment[2] === '2') {
        crease += .055 * source[i + 1] * Math.exp(-(((progress - .12) / .23) ** 2))
      }
    }
    const shadow = .045 * (1 - THREE.MathUtils.smoothstep(normalZ, -.8, .38))
    colors.push(1 - shadow - crease * .45 + nail * .036, 1 - shadow - crease - nail * .052, 1 - shadow - crease - nail * .031)
  }
  colors.push(.96, .93, .92)
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geometry
}

for (const { side, sign, joints: landmarks, rows: outline } of sleeves) {
  const [start, hinge, end] = landmarks.map(([x, y, z]) => fromPortrait(x, y, z))
  const upper = hinge.clone().sub(start), lower = end.clone().sub(hinge)
  const down = new THREE.Vector3(0, -1, 0)
  const shoulder = bone('Shoulder' + side, spine, start.x, start.y - hips.position.y - spine.position.y, start.z)
  const elbow = bone('Elbow' + side, shoulder, 0, -upper.length(), 0)
  const wrist = bone('Wrist' + side, elbow, 0, -lower.length(), 0)
  shoulder.quaternion.setFromUnitVectors(down, upper.normalize())
  elbow.quaternion.setFromUnitVectors(down, lower.normalize().applyQuaternion(shoulder.quaternion.clone().invert()))
  const jointIndices = [spine, shoulder, elbow, wrist].map((joint) => bones.indexOf(joint))
  skinGeometries.push({ geometry: makeSleeve(outline, start, hinge, end, landmarks, jointIndices), material: 'sleeve', name: 'PhotoSleeve' + side })
  skinGeometries.push({ geometry: makeHand(wrist, side, sign), material: 'hand', name: 'Hand' + side, space: wrist })
}

scene.updateMatrixWorld(true)
const skeleton = new THREE.Skeleton(bones)
for (const { geometry, material, name, space } of skinGeometries) {
  if (space) geometry.applyMatrix4(space.matrixWorld)
  const sleeve = new THREE.SkinnedMesh(geometry, materials[material])
  sleeve.name = name
  sleeve.bind(skeleton, new THREE.Matrix4())
  scene.add(sleeve)
}
for (const [material, entries] of skins) {
  const geometries = entries.map(({ joint, geometry }) => {
    geometry.applyMatrix4(joint.matrixWorld)
    const count = geometry.attributes.position.count
    const indexes = new Uint16Array(count * 4)
    const weights = new Float32Array(count * 4)
    const jointIndex = bones.indexOf(joint)
    for (let i = 0; i < count * 4; i += 4) {
      indexes[i] = jointIndex
      weights[i] = 1
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(indexes, 4))
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4))
    return geometry
  })
  const mesh = new THREE.SkinnedMesh(mergeGeometries(geometries), materials[material])
  mesh.bind(skeleton, new THREE.Matrix4())
  scene.add(mesh)
}
fitDeskSleeves(scene, bones)
const bytes = await new GLTFExporter().parseAsync(scene, { binary: true })
const output = new URL('../client/assets/rigged-avatar/', import.meta.url)
await mkdir(output, { recursive: true })
await writeFile(new URL('xiaxia.glb', output), Buffer.from(bytes))
