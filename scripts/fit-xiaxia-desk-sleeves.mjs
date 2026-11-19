import * as THREE from 'three'
import { setDeskArmPose } from '../client/xiaxia-arm-motion.mjs'

const pixelScale = .00148
const wristCenters = { L: 89.5, R: 816.5 }

export function fitDeskSleeves(scene, bones) {
  const bind = bones.map((bone) => bone.quaternion.clone())
  for (const [side, sign] of [['L', -1], ['R', 1]]) setDeskArmPose(scene, side, sign)
  scene.updateMatrixWorld(true)
  for (const side of ['L', 'R']) {
    const sleeve = scene.getObjectByName('PhotoSleeve' + side)
    const geometry = sleeve.geometry
    const positions = geometry.attributes.position
    const wrist = 395 + scene.getObjectByName('Wrist' + side).getWorldPosition(new THREE.Vector3()).x / pixelScale
    const shift = (wristCenters[side] - wrist) * .58
    const delta = new Float32Array(positions.count * 3)
    const point = new THREE.Vector3(), origin = new THREE.Vector3()
    const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3()
    const inverse = new THREE.Matrix4()
    for (let i = 0; i < positions.count; i++) {
      sleeve.getVertexPosition(i, point)
      const row = 515 + (1.47 - point.y) / pixelScale
      const amount = THREE.MathUtils.smoothstep(row, 910, 982)
      if (amount === 0) continue
      const dx = amount * ((point.x - (wrist - 395) * pixelScale) * .26 + shift * pixelScale)
      // Convert the cuff's fixed adjustment back to the sleeve's bind space.
      sleeve.applyBoneTransform(i, origin.set(0, 0, 0))
      sleeve.applyBoneTransform(i, x.set(1, 0, 0)).sub(origin)
      sleeve.applyBoneTransform(i, y.set(0, 1, 0)).sub(origin)
      sleeve.applyBoneTransform(i, z.set(0, 0, 1)).sub(origin)
      inverse.makeBasis(x, y, z).invert()
      point.set(dx, 0, 0).applyMatrix4(inverse).toArray(delta, i * 3)
    }
    const target = new THREE.BufferAttribute(delta, 3)
    target.name = 'cuffFit'
    geometry.morphTargetsRelative = true
    geometry.morphAttributes.position = [target]
    sleeve.updateMorphTargets()
  }
  for (const [index, bone] of bones.entries()) bone.quaternion.copy(bind[index])
  scene.updateMatrixWorld(true)
}
