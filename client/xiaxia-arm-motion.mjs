import * as THREE from 'three'

function joint(model, name) {
  const node = model.getObjectByName(name)
  if (!node?.isBone) throw new Error('三维角色缺少关节 ' + name)
  return node
}

export function setDeskArmPose(model, side, sign) {
  const shoulder = joint(model, 'Shoulder' + side)
  const elbow = joint(model, 'Elbow' + side)
  const wrist = joint(model, 'Wrist' + side)
  const up = new THREE.Vector3(sign * .035, .81, -.585).normalize()
  const across = up.clone().cross(new THREE.Vector3(0, .62, .78)).normalize()
  const dorsal = across.clone().cross(up)
  const palm = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, up, dorsal))
  wrist.quaternion.copy(shoulder.quaternion).multiply(elbow.quaternion).invert().multiply(palm)
  const curl = [[.10, .10, .07], [.065, .10, .06], [.085, .13, .08], [.12, .16, .095], [.16, .195, .11]]
  const adduction = [.24, .07, .025, -.055, -.10]
  const flex = new THREE.Quaternion(), inwards = new THREE.Quaternion()
  const x = new THREE.Vector3(1, 0, 0), z = new THREE.Vector3(0, 0, 1)
  for (const [digit, segments] of curl.entries()) {
    for (const [segment, name] of ['Finger', 'Tip', 'Distal'].entries()) {
      const finger = joint(model, name + side + digit)
      finger.quaternion.multiply(flex.setFromAxisAngle(x, segments[segment]))
      if (segment === 0) finger.quaternion.multiply(inwards.setFromAxisAngle(z, sign * adduction[digit]))
    }
  }
}
