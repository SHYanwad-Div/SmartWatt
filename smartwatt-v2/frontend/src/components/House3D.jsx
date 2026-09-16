import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { watts } from '../lib/format.js'
import { Card, useApp } from '../lib/ui.jsx'

/*
 * 3D cutaway of the home. Every appliance mirrors the live state from the
 * pipeline (the same estimate the breakdown table shows) and switches its relay
 * when clicked. Floating labels are real buttons, so the view is usable by
 * keyboard and screen reader as well as by pointer.
 */

const THEMES = {
  light: {
    background: 0xeef2ec, wall: 0xe6e1d8, wallLow: 0xd9d3c8, slab: 0xc9c2b6,
    floors: { living: 0xd8c29f, kitchen: 0xd2dade, bedroom: 0xdacbc0, bath: 0xcddcde },
    wood: 0x8a765f, fabric: 0x6d8f79, bedding: 0xe9e2d6, counter: 0xb8b1a6,
    shell: 0xf2f2ef, dark: 0x26282b, disabled: 0x8f8f8a, hover: 0x2d6a3e,
    hemi: 1.7, sun: 2.4, lamp: 10,
  },
  dark: {
    background: 0x131413, wall: 0x3a3936, wallLow: 0x302f2c, slab: 0x232320,
    floors: { living: 0x5a4d3b, kitchen: 0x3f4649, bedroom: 0x4c433d, bath: 0x3d4a4c },
    wood: 0x4f4336, fabric: 0x3b5445, bedding: 0x7d766b, counter: 0x55514b,
    shell: 0xcfd0cc, dark: 0x141517, disabled: 0x4d4d4a, hover: 0x3f9d5c,
    hemi: 0.85, sun: 0.9, lamp: 16,
  },
}

const HOME_VIEW = new THREE.Vector3(10.5, 10.5, 12.5)
const TARGET = new THREE.Vector3(0, 0.8, 0)

function buildHouse(t) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(t.background)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, t.hemi))
  const sun = new THREE.DirectionalLight(0xffffff, t.sun)
  sun.position.set(8, 14, 10)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 })
  scene.add(sun)

  const mat = (color, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02, ...extra })
  const box = (w, h, d, material, x, y, z, parent = scene) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    m.position.set(x, y, z)
    m.castShadow = true
    m.receiveShadow = true
    parent.add(m)
    return m
  }

  // slab and room floors
  box(12.5, 0.2, 8.5, mat(t.slab), 0, -0.1, 0)
  const floor = (w, d, color, x, z) => { box(w, 0.02, d, mat(color, { roughness: 0.9 }), x, 0.01, z).castShadow = false }
  floor(6, 4, t.floors.living, -3, 2)
  floor(6, 4, t.floors.kitchen, -3, -2)
  floor(6, 4, t.floors.bedroom, 3, -2)
  floor(6, 4, t.floors.bath, 3, 2)

  // cutaway walls: full height at the back and left, low at the front and right
  const wall = mat(t.wall)
  const low = mat(t.wallLow)
  box(12.2, 2.7, 0.12, wall, 0, 1.35, -4.06)
  box(0.12, 2.7, 8.24, wall, -6.06, 1.35, 0)
  box(12.2, 0.4, 0.12, low, 0, 0.2, 4.06)
  box(0.12, 0.4, 8.24, low, 6.06, 0.2, 0)
  const P = 1.8                             // partitions low enough to see over
  box(5.1, P, 0.1, wall, -3.45, P / 2, 0)
  box(5.1, P, 0.1, wall, 3.45, P / 2, 0)
  box(0.1, P, 3, wall, 0, P / 2, -2.5)
  box(0.1, P, 3, wall, 0, P / 2, 2.5)

  // furniture
  const wood = mat(t.wood)
  const fabric = mat(t.fabric)
  const bedding = mat(t.bedding)
  box(2.2, 0.45, 0.85, fabric, -3.2, 0.23, 3.2)          // sofa seat
  box(2.2, 0.5, 0.2, fabric, -3.2, 0.6, 3.55)            // sofa back
  box(1.0, 0.35, 0.55, wood, -3.2, 0.18, 2.1)            // coffee table
  box(1.8, 0.5, 0.4, wood, -2.6, 0.25, 0.3)              // TV console
  box(3.4, 0.9, 0.62, mat(t.counter), -2.7, 0.45, -3.62) // kitchen counter
  box(1.9, 0.45, 2.1, wood, 3.4, 0.23, -2.6)             // bed frame
  box(1.8, 0.14, 2.0, bedding, 3.4, 0.52, -2.55)         // mattress
  box(0.7, 0.12, 0.35, bedding, 3.0, 0.64, -3.35)        // pillows
  box(0.7, 0.12, 0.35, bedding, 3.8, 0.64, -3.35)
  box(1.5, 0.5, 0.75, mat(t.shell), 1.4, 0.25, 3.35)     // bathtub

  return { scene, mat, box }
}

function makeAppliances({ scene, mat, box }, t) {
  const handles = {}
  const glow = (color) => mat(0x000000, { emissive: new THREE.Color(color), emissiveIntensity: 0 })

  const add = (id, group, anchor, bodyMats, update) => {
    group.traverse((o) => { if (o.isMesh) o.userData.applianceId = id })
    scene.add(group)
    handles[id] = {
      id,
      group,
      anchor: new THREE.Vector3(...anchor),
      bodyMats: bodyMats.map((m) => ({ m, base: m.color.clone() })),
      update,
      lastEnabled: true,
      lastHover: false,
    }
    return handles[id]
  }

  // AC: split unit on the bedroom wall, louver swings and a cool airflow shows
  {
    const g = new THREE.Group()
    g.position.set(3.4, 2.15, -3.86)
    const body = mat(t.shell)
    box(1.1, 0.32, 0.24, body, 0, 0, 0, g)
    const louver = box(1.0, 0.03, 0.09, mat(t.dark), 0, -0.14, 0.12, g)
    const led = glow(0x39d353)
    box(0.05, 0.03, 0.02, led, 0.42, 0.06, 0.125, g)
    const air = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 1.1),
      new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    )
    air.position.set(0, -0.7, 0.45)
    air.rotation.x = -0.5
    air.raycast = () => {}                  // airflow is decoration, never a click target
    g.add(air)
    add('ac', g, [3.4, 2.65, -3.7], [body], (s, time) => {
      led.emissiveIntensity = s.on ? 2 : 0
      louver.rotation.x = s.on ? -0.5 + (s.motion ? Math.sin(time * 0.8) * 0.15 : 0) : 0
      air.material.opacity = s.on ? 0.1 + (s.motion ? 0.05 * Math.sin(time * 2) : 0) : 0
    })
  }

  // Refrigerator: compressor LED lights while it runs
  {
    const g = new THREE.Group()
    g.position.set(-5.35, 0, -3.42)
    const body = mat(t.shell)
    box(0.8, 1.8, 0.7, body, 0, 0.9, 0, g)
    box(0.78, 0.015, 0.02, mat(t.dark), 0, 1.25, 0.355, g)
    box(0.04, 0.35, 0.04, mat(t.dark), 0.3, 1.55, 0.37, g)
    box(0.04, 0.3, 0.04, mat(t.dark), 0.3, 0.95, 0.37, g)
    const led = glow(0x4fb3ff)
    box(0.06, 0.03, 0.02, led, -0.25, 1.7, 0.36, g)
    add('refrigerator', g, [-5.35, 2.1, -3.42], [body], (s) => {
      led.emissiveIntensity = s.on ? 2.2 : 0.15
    })
  }

  // Water heater: heating ring glows red
  {
    const g = new THREE.Group()
    g.position.set(5.72, 1.85, 1.2)
    const body = mat(t.shell)
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.8, 24), body)
    tank.castShadow = true
    g.add(tank)
    const ring = glow(0xff5a36)
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.025, 8, 32), ring)
    torus.rotation.x = Math.PI / 2
    g.add(torus)
    box(0.04, 0.5, 0.04, mat(t.counter), 0, -0.62, 0, g)
    add('geyser', g, [5.6, 2.55, 1.2], [body], (s, time) => {
      ring.emissiveIntensity = s.on ? 1.6 + (s.motion ? 0.6 * Math.sin(time * 3) : 0) : 0
    })
  }

  // TV: screen lights up with a slowly shifting picture
  {
    const g = new THREE.Group()
    g.position.set(-2.6, 1.2, 0.09)
    const frame = mat(t.dark)
    box(1.4, 0.82, 0.06, frame, 0, 0, 0, g)
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x050607, roughness: 0.3, emissive: new THREE.Color(0x000000), emissiveIntensity: 1,
    })
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.72), screenMat)
    screen.position.z = 0.032
    g.add(screen)
    const tint = new THREE.Color()
    add('tv', g, [-2.6, 1.85, 0.3], [frame], (s, time) => {
      if (s.on) {
        tint.setHSL(0.55 + (s.motion ? 0.08 * Math.sin(time * 0.6) : 0), 0.6, 0.45)
        screenMat.emissive.copy(tint)
      } else {
        screenMat.emissive.set(0x000000)
      }
    })
  }

  // Ceiling fan: blades spin
  {
    const g = new THREE.Group()
    g.position.set(-3.2, 2.55, 2.2)
    const metal = mat(t.shell, { metalness: 0.3, roughness: 0.4 })
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), metal)
    rod.position.y = 0.15
    g.add(rod)
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 16), metal))
    const blades = new THREE.Group()
    g.add(blades)
    const bladeMat = mat(t.wood)
    for (let i = 0; i < 3; i += 1) {
      const arm = new THREE.Group()
      arm.rotation.y = (i * Math.PI * 2) / 3
      box(0.8, 0.02, 0.16, bladeMat, 0.5, -0.02, 0, arm)
      blades.add(arm)
    }
    add('fan', g, [-3.4, 3.35, 2.6], [metal], (s, _time, dt) => {
      if (s.on && s.motion) blades.rotation.y += dt * 9
    })
  }

  // Lights: one lamp per room, each a real light source
  {
    const g = new THREE.Group()
    const lampMat = mat(0xfff4dd, { emissive: new THREE.Color(0xffc56b), emissiveIntensity: 0 })
    const spots = [[-1.6, 2.6, 3.0], [-3.0, 2.6, -2.0], [3.0, 2.6, -1.4], [3.6, 2.6, 2.2]]
    const lamps = spots.map(([x, y, z]) => {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 20), lampMat)
      disc.position.set(x, y, z)
      g.add(disc)
      const light = new THREE.PointLight(0xffc97a, 0, 7, 2)
      light.position.set(x, y - 0.25, z)
      g.add(light)
      return light
    })
    // label sits on the bathroom lamp; the living room already carries TV, fan and router labels
    add('lights', g, [3.6, 2.95, 2.2], [], (s) => {
      lampMat.emissiveIntensity = s.on ? 2.5 : 0
      for (const light of lamps) light.intensity = s.on ? t.lamp : 0
    })
  }

  // Washing machine: drum turns behind the glass
  {
    const g = new THREE.Group()
    g.position.set(4.6, 0, 3.25)
    const body = mat(t.shell)
    box(0.62, 0.88, 0.62, body, 0, 0.44, 0, g)
    const doorRing = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 10, 32), mat(t.counter, { metalness: 0.4 }))
    doorRing.position.set(0, 0.46, 0.315)
    g.add(doorRing)
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9cc9e0, transparent: true, opacity: 0.55, emissive: new THREE.Color(0x3b8fd6), emissiveIntensity: 0,
    })
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.18, 32), glassMat)
    glass.position.set(0, 0.46, 0.318)
    g.add(glass)
    const drum = new THREE.Group()
    drum.position.set(0, 0.46, 0.3)
    g.add(drum)
    box(0.05, 0.22, 0.02, mat(t.dark), 0, 0.06, 0, drum)
    box(0.5, 0.08, 0.02, mat(t.dark), 0, 0.8, 0.31, g)
    add('washing_machine', g, [4.6, 1.2, 3.25], [body], (s, _time, dt) => {
      glassMat.emissiveIntensity = s.on ? 0.5 : 0
      if (s.on && s.motion) drum.rotation.z -= dt * 6
    })
  }

  // Microwave: window glows while heating
  {
    const g = new THREE.Group()
    g.position.set(-2.2, 0.9, -3.58)
    const body = mat(t.shell)
    box(0.56, 0.32, 0.4, body, 0, 0.16, 0, g)
    const windowMat = mat(0x1a1a1a, { emissive: new THREE.Color(0xffa040), emissiveIntensity: 0 })
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.22), windowMat)
    pane.position.set(-0.07, 0.16, 0.201)
    g.add(pane)
    box(0.12, 0.26, 0.01, mat(t.dark), 0.2, 0.16, 0.2, g)
    add('microwave', g, [-2.2, 1.5, -3.58], [body], (s, time) => {
      windowMat.emissiveIntensity = s.on ? 1.4 + (s.motion ? 0.3 * Math.sin(time * 5) : 0) : 0
    })
  }

  // Router: activity LEDs blink
  {
    const g = new THREE.Group()
    g.position.set(-1.9, 0.5, 0.35)
    const body = mat(t.dark)
    box(0.3, 0.05, 0.2, body, 0, 0.025, 0, g)
    const leds = [0, 1, 2].map((i) => {
      const m = glow(0x39d353)
      box(0.02, 0.012, 0.01, m, -0.08 + i * 0.05, 0.03, 0.101, g)
      return m
    })
    box(0.015, 0.18, 0.015, mat(t.dark), 0.12, 0.14, -0.06, g)
    add('router', g, [-1.9, 0.95, 0.35], [body], (s, time) => {
      leds.forEach((m, i) => {
        m.emissiveIntensity = s.on ? (s.motion && Math.sin(time * 6 + i * 2) < 0 ? 0.4 : 2) : 0
      })
    })
  }

  // Appliances added later (not in the model above) get a generic unit on a shelf.
  let slot = 0
  const addGeneric = (id) => {
    const g = new THREE.Group()
    g.position.set(-5.4 + (slot % 8) * 0.6, 0, -0.45 - Math.floor(slot / 8) * 0.6)
    slot += 1
    const body = mat(t.shell)
    box(0.45, 0.5, 0.4, body, 0, 0.25, 0, g)
    const led = glow(0x39d353)
    box(0.06, 0.04, 0.02, led, 0.12, 0.42, 0.21, g)
    return add(id, g, [g.position.x, 0.9, g.position.z], [body], (s) => {
      led.emissiveIntensity = s.on ? 2 : 0
    })
  }

  return { handles, addGeneric }
}

function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose()
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
  })
}

export default function House3D({ rows, canControl, onToggle, theme, span = 12 }) {
  const { notify } = useApp()
  const mountRef = useRef(null)
  const labelRefs = useRef({})
  const rowsRef = useRef(rows)
  const hoverRef = useRef(null)
  const resetRef = useRef(() => {})
  const [hover, setHover] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  rowsRef.current = rows

  // Latest props for handlers that live inside the render loop.
  const activateRef = useRef(null)
  activateRef.current = async (id) => {
    const row = rowsRef.current.find((r) => r.id === id)
    if (!row || busy) return
    if (!canControl) {
      notify({ level: 'info', title: 'View only', message: 'Your role can see appliances but not switch them.' })
      return
    }
    if (!row.controllable) {
      notify({ level: 'info', title: `${row.name} is not switchable`, message: 'It has no relay, so it can only be monitored.' })
      return
    }
    setBusy(id)
    try {
      await onToggle(row)
    } finally {
      setBusy(null)
    }
  }

  const setHovered = (id) => {
    if (hoverRef.current === id) return
    hoverRef.current = id
    setHover(id)
  }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return undefined

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' })
    } catch {
      setError('The 3D view needs WebGL, which this browser does not provide. The appliance breakdown table has the same controls.')
      return undefined
    }
    setError('')

    const t = THEMES[theme === 'dark' ? 'dark' : 'light']
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    const canvas = renderer.domElement
    canvas.style.cursor = 'grab'
    mount.appendChild(canvas)

    const ctx = buildHouse(t)
    const { scene } = ctx
    const { handles, addGeneric } = makeAppliances(ctx, t)

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    // The default view frames the house for a wide card. On a narrow (phone)
    // card the horizontal field of view shrinks and the house was cropped at
    // the sides, so pull the camera back in proportion to how narrow it is.
    const homeFor = (aspect) => {
      const stretch = Math.min(2.2, Math.max(1, 1.45 / aspect))
      return TARGET.clone().add(HOME_VIEW.clone().sub(TARGET).multiplyScalar(stretch))
    }
    camera.position.copy(HOME_VIEW)
    const controls = new OrbitControls(camera, canvas)
    controls.target.copy(TARGET)
    controls.enableDamping = true
    controls.enablePan = false
    controls.minDistance = 7
    controls.maxDistance = 40
    controls.maxPolarAngle = Math.PI * 0.46       // never dip under the floor
    controls.update()
    let userMoved = false
    controls.addEventListener('start', () => { userMoved = true })
    resetRef.current = () => {
      userMoved = false
      camera.position.copy(homeFor(camera.aspect))
      controls.target.copy(TARGET)
      controls.update()
    }

    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      if (!userMoved) {                           // refit only until the user takes over
        camera.position.copy(homeFor(camera.aspect))
        controls.update()
      }
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    // Picking: the first surface under the pointer decides, so a wall in front
    // of an appliance blocks the click instead of switching something hidden.
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const pickAt = (e) => {
      const r = canvas.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObjects(scene.children, true)[0]
      return hit?.object.userData.applianceId || null
    }
    let down = null
    const onDown = (e) => { down = { x: e.clientX, y: e.clientY } }
    const onMove = (e) => {
      if (e.buttons) return
      const id = pickAt(e)
      setHovered(id)
      canvas.style.cursor = id ? 'pointer' : 'grab'
    }
    const onUp = (e) => {
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > 6) return                       // it was a drag to rotate
      const id = pickAt(e)
      if (id) activateRef.current(id)
    }
    const onLeave = () => setHovered(null)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointerleave', onLeave)

    const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let onScreen = true
    const io = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting })
    io.observe(mount)

    const disabledColor = new THREE.Color(t.disabled)
    const hoverColor = new THREE.Color(t.hover)
    const black = new THREE.Color(0x000000)
    const v = new THREE.Vector3()
    let raf = 0
    let last = performance.now()

    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (!onScreen || document.hidden) return
      const time = now / 1000

      for (const row of rowsRef.current) {
        if (row.id === 'other') continue
        const h = handles[row.id] || addGeneric(row.id)
        if (h.lastEnabled !== row.enabled) {
          h.bodyMats.forEach(({ m, base }) => m.color.copy(row.enabled ? base : disabledColor))
          h.lastEnabled = row.enabled
        }
        const hovered = hoverRef.current === row.id
        if (h.lastHover !== hovered) {
          h.bodyMats.forEach(({ m }) => {
            m.emissive.copy(hovered ? hoverColor : black)
            m.emissiveIntensity = hovered ? 0.4 : 0
          })
          h.lastHover = hovered
        }
        h.update({ on: row.enabled && row.state, enabled: row.enabled, motion }, time, dt)
      }

      controls.update()
      renderer.render(scene, camera)

      const w = mount.clientWidth
      const hgt = mount.clientHeight
      const entries = Object.entries(labelRefs.current).filter(([, el]) => el)
      // read every size before writing any transform, so the loop does not
      // force a layout per label
      const sizes = entries.map(([, el]) => [el.offsetWidth, el.offsetHeight])
      entries.forEach(([id, el], i) => {
        const h = handles[id]
        if (!h) {
          el.style.visibility = 'hidden'
          return
        }
        v.copy(h.anchor).project(camera)
        const inView = v.z < 1 && Math.abs(v.x) <= 1.02 && Math.abs(v.y) <= 1.02
        // Keep the whole pill inside the card. On a narrow phone card a label
        // near the edge was cut off by the card's clipped border.
        const [lw, lh] = sizes[i]
        const x = Math.min(Math.max((v.x + 1) / 2 * w, lw / 2 + 4), w - lw / 2 - 4)
        const y = Math.min(Math.max((1 - v.y) / 2 * hgt, lh + 4), hgt - 4)
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
        el.style.visibility = inView ? 'visible' : 'hidden'
      })
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      controls.dispose()
      disposeScene(scene)
      renderer.dispose()
      canvas.remove()
    }
  }, [theme])

  const items = rows.filter((r) => r.id !== 'other')
  const other = rows.find((r) => r.id === 'other')

  return (
    <Card
      span={span}
      title="3D home"
      sub="Live appliance state, estimated from the total signal. Click an appliance or its label to switch it."
      actions={<button type="button" className="btn sm" onClick={() => resetRef.current()}>Reset view</button>}
    >
      <div className="h3d">
        <div
          ref={mountRef}
          className="h3d-canvas"
          role="img"
          aria-label="3D cutaway of the home showing each appliance as on, idle or switched off"
        />
        <div className="h3d-labels">
          {items.map((r) => {
            const status = !r.enabled ? 'disabled' : r.state ? 'on' : 'idle'
            const text = status === 'disabled' ? 'Switched off' : status === 'on' ? watts(r.power_w) : 'Idle'
            const action = !canControl ? 'view only'
              : !r.controllable ? 'not switchable'
                : r.enabled ? 'activate to turn off' : 'activate to turn on'
            return (
              <button
                key={r.id}
                ref={(el) => { labelRefs.current[r.id] = el }}
                type="button"
                className={`h3d-label ${status} ${hover === r.id ? 'hover' : ''}`}
                style={{ visibility: 'hidden' }}
                disabled={busy === r.id}
                aria-label={`${r.name}: ${text}, ${action}`}
                title={`${r.name} · ${text} · ${action}`}
                onClick={() => activateRef.current(r.id)}
                onMouseEnter={() => setHovered(r.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(r.id)}
                onBlur={() => setHovered(null)}
              >
                <span aria-hidden="true">{r.icon}</span>
                <span className="nm">{r.name}</span>
                <span className={`dot ${status === 'on' ? 'on' : status === 'disabled' ? 'off' : ''}`} aria-hidden="true" />
                {text}
              </button>
            )
          })}
        </div>
        {error && <div className="empty h3d-error">{error}</div>}
        <div className="h3d-hint">
          Drag to rotate · scroll or pinch to zoom
          {other && other.power_w > 1 ? ` · ${watts(other.power_w)} not yet matched to an appliance` : ''}
        </div>
      </div>
    </Card>
  )
}
