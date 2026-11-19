import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const PORTRAIT_WIDTH = 768
const PORTRAIT_HEIGHT = 1080
const OUTPUT_HEIGHT = 1920
const WORLD_PER_PIXEL = .00148
const STAGE_X = (PORTRAIT_WIDTH / 2 - 395) * WORLD_PER_PIXEL
const STAGE_Y = 1.47 + (515 - PORTRAIT_HEIGHT / 2) * WORLD_PER_PIXEL
const STAGE_HEIGHT = PORTRAIT_HEIGHT * WORLD_PER_PIXEL

function placeReferencePortrait(scene, portrait) {
  const geometry = new THREE.PlaneGeometry(PORTRAIT_WIDTH * WORLD_PER_PIXEL, STAGE_HEIGHT)
  const uv = geometry.attributes.uv
  // The face model reads the portrait from the top down. Use the same UV
  // convention and texture for the fixed original and its facial overlay.
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
  const material = new THREE.MeshBasicMaterial({ map: portrait, toneMapped: false })
  const plane = new THREE.Mesh(geometry, material)
  plane.name = 'ReferencePortrait'
  plane.position.set(STAGE_X, STAGE_Y, -.72)
  scene.background = new THREE.Color(0x776455)
  scene.add(plane)
}

function configureMouth(material) {
  const speech = { value: new THREE.Vector4() }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.speech = speech
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform vec4 speech;')
      .replace('#include <map_fragment>', /* glsl */ `
        #ifdef USE_MAP
          vec2 imageSize = vec2(${PORTRAIT_WIDTH}.0, ${PORTRAIT_HEIGHT}.0);
          vec2 pixel = vMapUv * imageSize;
          vec2 source = pixel;
          float mouthAlpha = 0.0;
          vec3 inside = vec3(0.0);
          if (abs(pixel.x - 398.0) < 58.0 && abs(pixel.y - 436.0) < 47.0) {
            float around = 1.0 - smoothstep(14.0, 41.0, abs(pixel.y - 436.0));
            float cheek = 1.0 - smoothstep(27.0, 55.0, abs(pixel.x - 398.0));
            float width = 1.0 + (0.14 * speech.z - 0.27 * speech.y) * around * cheek;
            source.x = 398.0 + (pixel.x - 398.0) / width;
            float across = (source.x - 398.0) / 31.0;
            float edge = min(1.0, abs(across));
            float lipLine = 431.8 + 3.8 * (1.0 - edge * edge) + 0.38 * across;
            float smile = 3.0 * speech.w * around * cheek * edge * edge;
            float opening = smoothstep(0.035, 0.95, speech.x);
            float innerEdge = min(1.0, abs(source.x - 398.0) / (24.0 + 4.0 * speech.z));
            float shape = pow(max(0.0, 1.0 - innerEdge * innerEdge), 1.20);
            float height = opening * (10.8 + 1.5 * speech.y);
            float top = lipLine - smile - shape * height * 0.22;
            float bottom = lipLine - smile + shape * height * 0.78;

            // Follow the photographed upper/lower lips into the opening. The
            // original seam stays visible only while it is still a closed lip.
            float seam = smoothstep(0.0, 0.34, opening) * 0.85 * shape;
            if (pixel.y < (top + bottom) * 0.5) {
              source.y += (lipLine - top - seam) * (1.0 - smoothstep(0.0, 24.0, abs(pixel.y - top)));
            } else {
              source.y += (lipLine - bottom + seam) * (1.0 - smoothstep(0.0, 34.0, abs(pixel.y - bottom)));
            }
            float rim = min(pixel.y - top, bottom - pixel.y);
            mouthAlpha = smoothstep(-0.54, 0.83, rim) * smoothstep(0.0, 0.16, opening) * (1.0 - smoothstep(0.88, 1.0, innerEdge));
            float down = clamp((pixel.y - top) / max(1.0, bottom - top), 0.0, 1.0);
            inside = mix(vec3(0.058, 0.017, 0.017), vec3(0.126, 0.038, 0.033), down * down);

            // Warm, shaded upper teeth appear only inside a sufficiently open
            // mouth. Rounded ends disappear before they reach either corner.
            float toothHeight = min(2.35, (bottom - top) * 0.23);
            float toothBottom = top + toothHeight * (1.0 - 3.5 * innerEdge * innerEdge);
            float teeth = smoothstep(0.38, 1.15, pixel.y - top) * smoothstep(-0.3, 0.7, toothBottom - pixel.y);
            teeth *= (1.0 - smoothstep(0.28, 0.48, innerEdge)) * smoothstep(0.68, 0.96, speech.x) * (1.0 - 0.7 * speech.y);
            inside = mix(inside, vec3(0.39, 0.25, 0.20), teeth * 0.60);
          }
          vec4 portraitColor = texture2D(map, source / imageSize);
          diffuseColor *= vec4(mix(portraitColor.rgb, inside, mouthAlpha), portraitColor.a);
          float leftEye = 1.0 - smoothstep(0.65, 1.0, length((pixel - vec2(351.0, 347.0)) / vec2(56.0, 40.0)));
          float rightEye = 1.0 - smoothstep(0.65, 1.0, length((pixel - vec2(441.0, 347.0)) / vec2(56.0, 40.0)));
          float lips = 1.0 - smoothstep(0.76, 1.0, length((pixel - vec2(398.0, 436.0)) / vec2(72.0, 54.0)));
          diffuseColor.a *= max(lips, max(leftEye, rightEye));
        #endif
      `)
  }
  return speech.value
}

function disposeScene(scene) {
  const materials = new Set()
  const geometries = new Set()
  const skeletons = new Set()
  const textures = new Set()
  scene.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry)
    if (node.material) for (const mat of [].concat(node.material)) materials.add(mat)
    if (node.skeleton) skeletons.add(node.skeleton)
  })
  for (const geometry of geometries) geometry.dispose()
  for (const mat of materials) {
    for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value)
    mat.dispose()
  }
  for (const texture of textures) texture.dispose()
  for (const skeleton of skeletons) skeleton.dispose()
}

async function mount(host, modelUrl, signal, onContextLost) {
  const response = await fetch(modelUrl, { signal })
  if (!response.ok) throw new Error('三维角色模型无法加载')
  const asset = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '')
  const scene = new THREE.Scene()
  const model = asset.scene
  scene.add(model)
  let renderer, resize
  try {
    signal.throwIfAborted()
    const face = model.getObjectByName('PhotoFace')
    if (!face?.morphTargetInfluences) throw new Error('角色缺少面部绑定')
    const portraitUrl = new URL(modelUrl, document.baseURI)
    portraitUrl.searchParams.set('asset', 'poster')
    const source = await new THREE.ImageLoader().loadAsync(portraitUrl.href)
    signal.throwIfAborted()
    const portrait = new THREE.Texture(source)
    portrait.colorSpace = THREE.SRGBColorSpace
    portrait.flipY = false
    portrait.generateMipmaps = false
    portrait.minFilter = THREE.LinearFilter
    portrait.needsUpdate = true
    face.material.map = portrait
    face.material.toneMapped = false
    face.material.needsUpdate = true
    face.renderOrder = 3
    const speech = configureMouth(face.material)

    placeReferencePortrait(scene, portrait)
    scene.attach(face)
    model.visible = false
    const camera = new THREE.OrthographicCamera(-1, 1, STAGE_HEIGHT / 2, -STAGE_HEIGHT / 2, .05, 20)
    camera.position.set(STAGE_X, STAGE_Y, 4)
    camera.lookAt(STAGE_X, STAGE_Y, 0)
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    portrait.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
    renderer.domElement.className = 'dfy-rigged-canvas'
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    host.appendChild(renderer.domElement)
    const broadcast = Boolean(host.closest('.dfy-broadcast'))
    const fit = () => {
      const height = host.clientHeight
      const width = Math.min(host.clientWidth, Math.round(height * PORTRAIT_WIDTH / PORTRAIT_HEIGHT))
      if (height <= 0 || width <= 0) return
      const aspect = broadcast && Math.abs(width / height - 9 / 16) < .005 ? 9 / 16 : width / height
      const minimum = broadcast ? OUTPUT_HEIGHT : PORTRAIT_HEIGHT
      const density = Math.min(2, window.devicePixelRatio || 1)
      const bufferHeight = Math.min(OUTPUT_HEIGHT, renderer.capabilities.maxTextureSize, Math.max(minimum, Math.round(height * density)))
      renderer.setSize(Math.round(bufferHeight * aspect), bufferHeight, false)
      renderer.domElement.style.width = width + 'px'
      renderer.domElement.style.marginInline = 'auto'
      camera.right = STAGE_HEIGHT * aspect / 2
      camera.left = -camera.right
      camera.updateProjectionMatrix()
    }
    resize = new ResizeObserver(fit)
    resize.observe(host)
    fit()

    return {
      render({ pose }) {
        const features = face.morphTargetInfluences
        speech.set(pose.opening, Math.max(0, -pose.form), Math.max(0, pose.form), Math.max(0, pose.expression))
        features[0] = pose.blinkLeft
        features[1] = pose.blinkRight
        face.visible = speech.lengthSq() > .0001 || pose.blinkLeft > .001 || pose.blinkRight > .001
        renderer.render(scene, camera)
      },
      dispose() {
        resize.disconnect()
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
        renderer.domElement.remove()
        disposeScene(scene)
        renderer.dispose()
        renderer.forceContextLoss()
      },
    }
  } catch (error) {
    resize?.disconnect()
    renderer?.domElement.remove()
    disposeScene(scene)
    renderer?.dispose()
    renderer?.forceContextLoss()
    throw error
  }
}

window.__DafeiyuRiggedAvatar = { mount }
