import { newwormhole, dial } from './dial.js'

let receiving
let sending
let sendqueue = []
let datachannel
let serviceworker
let signalserver = new URL(location.href)
const hacks = {}

const pick = e => {
  const files = document.getElementById('filepicker').files
  for (let i = 0; i < files.length; i++) {
    queue(files[i])
  }
}

const drop = e => {
  const files = e.dataTransfer.files
  for (let i = 0; i < files.length; i++) {
    queue(files[i])
  }

  // A shortcut to save users a click. If we're disconnected and they drag
  // a file in treat it as a click on the new/join wormhole button.
  // TODO track connection state like a decent human being instead of using
  // the filepicker state...
  if (document.getElementById('filepicker').disabled) {
    connect()
  }
}

class DataChannelWriter {
  constructor (dc) {
    this.dc = dc
    this.chunksize = 32 << 10
    this.bufferedAmountHighThreshold = 1 << 20
    this.dc.bufferedAmountLowThreshold = 512 << 10
    this.dc.onbufferedamountlow = () => {
      this.resolve()
    }
    this.ready = new Promise((resolve) => {
      this.resolve = resolve
      this.resolve()
    })
  }

  async write (buf) {
    for (let offset = 0; offset < buf.length; offset += this.chunksize) {
      let end = offset + this.chunksize
      if (end > buf.length) {
        end = buf.length
      }
      await this.ready
      this.dc.send(buf.subarray(offset, end))
    }
    if (this.dc.bufferedAmount >= this.bufferedAmountHighThreshold) {
      this.ready = new Promise(resolve => { this.resolve = resolve })
    }
  }
}

const queue = async f => {
  const item = { f }
  item.offset = 0
  item.li = document.createElement('li')
  item.li.innerText = `... ${f.name}`
  document.getElementById('transfers').appendChild(item.li)
  sendqueue.push(item)
  send()
}

const send = async () => {
  if (!datachannel) {
    console.log("not connected yet")
    return
  }
  if (sending) {
    console.log("haven't finished sending", sending.f.name)
    return
  }
  if (sendqueue.length < 1) {
    console.log("send queue is empty")
    return
  }

  sending = sendqueue.shift()
  console.log('sending', sending.f.name)
  sending.li.innerText = `↑ ${sending.f.name}`
  sending.li.appendChild(document.createElement('progress'))
  sending.progress = sending.li.getElementsByTagName('progress')[0]

  datachannel.send(new TextEncoder('utf8').encode(JSON.stringify({
    name: sending.f.name,
    size: sending.f.size,
    type: sending.f.type
  })))

  const writer = new DataChannelWriter(datachannel)
  if (!sending.f.stream) {
    // Hack around Safari's lack of Blob.stream() and arrayBuffer().
    // This is unbenchmarked and could probably be made better.
    const read = b => {
      return new Promise(resolve => {
        const fr = new FileReader()
        fr.onload = (e) => {
          resolve(new Uint8Array(e.target.result))
        }
        fr.readAsArrayBuffer(b)
      })
    }
    const chunksize = 64 << 10
    while (sending.offset < sending.f.size) {
      let end = sending.offset + chunksize
      if (end > sending.f.size) {
        end = sending.f.size
      }
      await writer.write(await read(sending.f.slice(sending.offset, end)))
      sending.offset = end
      sending.progress.value = sending.offset / sending.f.size
    }
  } else {
    const reader = sending.f.stream().getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      await writer.write(value)
      sending.offset += value.length
      sending.progress.value = sending.offset / sending.f.size
    }
  }
  sending.li.removeChild(sending.progress)
  sending = null
  return send()
}

const triggerDownload = receiving => {
  if (serviceworker) {
    // `<a download=...>` doesn't work with service workers on Chrome yet.
    // See https://bugs.chromium.org/p/chromium/issues/detail?id=468227
    //
    // Possible solutions:
    //
    // - `window.open` is blocked as a popup.
    // window.open(`${SW_PREFIX}/${receiving.id}`);
    //
    // - And this is quite scary but `Content-Disposition` to the rescue!
    //   It will navigate to 404 page if there is no service worker for some reason...
    //   But if `postMessage` didn't throw we should be safe.
    window.location = `/_/${receiving.id}`
  } else if (hacks.noblob) {
    const blob = new Blob([receiving.data], { type: receiving.type })
    const reader = new FileReader()
    reader.onloadend = () => {
      receiving.a.href = reader.result
      receiving.a.download = receiving.name
    }
    reader.readAsDataURL(blob)
  } else {
    const blob = new Blob([receiving.data], { type: receiving.type })
    receiving.a.href = URL.createObjectURL(blob)
    receiving.a.download = receiving.name
    receiving.a.click()
  }
}

// receive is the new message handler.
//
// This function cannot be async without carefully thinking through the
// order of messages coming in.
const receive = e => {
  if (!receiving) {
    receiving = JSON.parse(new TextDecoder('utf8').decode(e.data))
    receiving.id = Math.random().toString(16).substring(2) + '-' + encodeURIComponent(receiving.name)
    receiving.offset = 0
    if (!serviceworker) { receiving.data = new Uint8Array(receiving.size) }

    receiving.li = document.createElement('li')
    receiving.a = document.createElement('a')
    receiving.li.appendChild(receiving.a)
    receiving.a.appendChild(document.createTextNode(`↓ ${receiving.name}`))
    receiving.progress = document.createElement('progress')
    receiving.li.appendChild(receiving.progress)
    document.getElementById('transfers').appendChild(receiving.li)

    if (serviceworker) {
      serviceworker.postMessage({
        id: receiving.id,
        type: 'metadata',
        name: receiving.name,
        size: receiving.size,
        filetype: receiving.type
      })
      triggerDownload(receiving)
    }

    return
  }

  const chunkSize = e.data.byteLength

  if (receiving.offset + chunkSize > receiving.size) {
    const error = 'received more bytes than expected'
    if (serviceworker) { serviceworker.postMessage({ id: receiving.id, type: 'error', error }) }
    throw error
  }

  if (serviceworker) {
    serviceworker.postMessage(
      {
        id: receiving.id,
        type: 'data',
        data: e.data,
        offset: receiving.offset
      },
      [e.data]
    )
  } else {
    receiving.data.set(new Uint8Array(e.data), receiving.offset)
  }

  receiving.offset += chunkSize
  receiving.progress.value = receiving.offset / receiving.size

  if (receiving.offset === receiving.size) {
    if (serviceworker) {
      serviceworker.postMessage({ id: receiving.id, type: 'end' })
    } else {
      triggerDownload(receiving)
    }

    receiving.li.removeChild(receiving.progress)
    receiving = null
  }
}

// initPeerConnection initialises a PeerConnection object.
const initPeerConnection = (iceServers) => {
  // TODO fix the case in json object in pion/webrtc
  let normalisedICEServers = []
  for (let i=0; i<iceServers.length; i++) {
    normalisedICEServers.push({
      urls: iceServers[i].URLs,
      username: iceServers[i].Username,
      credential: iceServers[i].Credential
    })
  }
  const pc = new RTCPeerConnection({
    iceServers: normalisedICEServers
  })
  pc.onconnectionstatechange = e => {
    switch (pc.connectionState) {
      case 'connected':
        // Handled in datachannel.onopen.
        console.log('webrtc connected')
        break
      case 'failed':
        disconnected()
        console.log('webrtc connection failed connectionState:', pc.connectionState, 'iceConnectionState', pc.iceConnectionState)
        document.getElementById('info').innerHTML = 'NETWORK ERROR'
        break
      case 'disconnected':
      case 'closed':
        disconnected()
        console.log('webrtc connection closed')
        document.getElementById('info').innerHTML = 'DISCONNECTED'
        pc.onconnectionstatechange = null
        break
    }
  }
  const dc = pc.createDataChannel('data', { negotiated: true, id: 0 })
  dc.onopen = () => {
    connected()
    datachannel = dc
    send() // work through the send queue if it has anything
  }
  dc.onmessage = receive
  dc.binaryType = 'arraybuffer'
  dc.onclose = e => {
    disconnected()
    console.log('datachannel closed')
    document.getElementById('info').innerHTML = 'DISCONNECTED'
  }
  dc.onerror = e => {
    disconnected()
    console.log('datachannel error:', e.error)
    document.getElementById('info').innerHTML = 'NETWORK ERROR'
  }
  return pc
}

const connect = async () => {
  try {
    dialling()
    if (document.getElementById('magiccode').value === '') {
      document.getElementById('info').innerHTML = 'WAITING FOR THE OTHER SIDE - SHARE CODE OR URL'
      const [code, finish] = await newwormhole(signalserver.href, initPeerConnection)
      document.getElementById('magiccode').value = code
      codechange()
      location.hash = code
      signalserver.hash = code
      const qr = webwormhole.qrencode(signalserver.href)
      if (qr === null) {
        document.getElementById('qr').src = ''
      } else {
        document.getElementById('qr').src = URL.createObjectURL(new Blob([qr]))
      }
      await finish
    } else {
      document.getElementById('info').innerHTML = 'CONNECTING'
      await dial(signalserver.href, document.getElementById('magiccode').value, initPeerConnection)
    }
  } catch (err) {
    disconnected()
    if (err === 'bad key') {
      document.getElementById('info').innerHTML = 'BAD KEY'
    } else if (err === 'bad code') {
      document.getElementById('info').innerHTML = 'INVALID CODE'
    } else if (err === 'no such slot') {
      document.getElementById('info').innerHTML = 'NO SUCH SLOT'
    } else if (err === 'timed out') {
      document.getElementById('info').innerHTML = 'CODE TIMED OUT GENERATE ANOTHER'
    } else if (err === 'could not connect to signalling server') {
      document.getElementById('info').innerHTML = 'COULD NOT CONNECT TO SIGNALLING SERVER - ENSURE IT IS REACHABLE AND IS RUNNING A COMPATABLE VERSION'
    } else {
      document.getElementById('info').innerHTML = 'COULD NOT CONNECT'
      console.log(err)
    }
  }
}

const dialling = () => {
  document.body.classList.add('dialling')
  document.body.classList.remove('connected')
  document.body.classList.remove('disconnected')

  document.getElementById('filepicker').disabled = false
  document.getElementById('dial').disabled = true
  document.getElementById('magiccode').readOnly = true
}

const connected = () => {
  document.body.classList.remove('dialling')
  document.body.classList.add('connected')
  document.body.classList.remove('disconnected')

  document.getElementById('info').innerHTML = 'OR DRAG FILES TO SEND'

  location.hash = ''
}

const disconnected = () => {
  datachannel = null
  sendqueue = []

  document.body.classList.remove('dialling')
  document.body.classList.remove('connected')
  document.body.classList.add('disconnected')

  document.getElementById('dial').disabled = false
  document.getElementById('magiccode').readOnly = false
  document.getElementById('magiccode').value = ''
  codechange()
  document.getElementById('filepicker').disabled = true

  location.hash = ''

  if (serviceworker && receiving) { serviceworker.postMessage({ id: receiving.id, type: 'error', error: 'rtc disconnected' }) }
}

const highlight = e => {
  document.body.classList.add('highlight')
}

const unhighlight = e => {
  document.body.classList.remove('highlight')
}

const preventdefault = e => {
  e.preventDefault()
  e.stopPropagation()
}

const hashchange = e => {
  const newhash = location.hash.substring(1)
  if (newhash !== '' && newhash !== document.getElementById('magiccode').value) {
    console.log('hash changed dialling new code')
    document.getElementById('magiccode').value = newhash
    codechange()
    connect()
  }
}

const codechange = e => {
  if (document.getElementById('magiccode').value === '') {
    document.getElementById('dial').value = 'NEW WORMHOLE'
  } else {
    document.getElementById('dial').value = 'JOIN WORMHOLE'
  }
}

const autocompletehint = e => {
  const words = document.getElementById('magiccode').value.split('-');
  const prefix = words[words.length-1]
  const hint = webwormhole.match(prefix)
  document.getElementById('autocomplete').innerText = hint
}

const autocomplete = e => {
  // TODO repeated tabs cycle through all matches?
  if (e.keyCode === 9) {
    e.preventDefault() // Prevent tabs from doing tab things.
    const words = document.getElementById('magiccode').value.split('-');
    const prefix = words[words.length-1]
    const hint = webwormhole.match(prefix)
    if (hint === '') {
      return
    }
    document.getElementById('magiccode').value += hint.substring(prefix.length) + '-'
    document.getElementById('autocomplete').innerText = ''
  }
}

const browserhacks = () => {
  // Detect for features we need for this to work.
  if (!(window.WebSocket) ||
      !(window.RTCPeerConnection) ||
      !(window.WebAssembly)) {
    hacks.browserunsupported = true
    hacks.nosw = true
    hacks.nowasm = true
    console.log('quirks: browser not supported')
    console.log(
      'websocket:', !!window.WebSocket,
      'webrtc:', !!window.RTCPeerConnection,
      'wasm:', !!window.WebAssembly
    )
    return
  }

  // Polyfill for Safari WASM streaming.
  if (!WebAssembly.instantiateStreaming) {
    WebAssembly.instantiateStreaming = async (resp, importObject) => {
      const source = await (await resp).arrayBuffer()
      return await WebAssembly.instantiate(source, importObject)
    }
    console.log('quirks: using wasm streaming polyfill')
  }

  // Safari cannot save files from service workers.
  if (window.safari) {
    hacks.nosw = true
    console.log('quirks: serviceworkers disabled on safari')
  }

  if (!(navigator.serviceWorker)) {
    hacks.nosw = true
    console.log('quirks: no serviceworkers')
  }

  // Work around iOS Safari <= 12 not being able to download blob URLs.
  // This can die when iOS Safari usage is less than 1% on this table:
  // https://caniuse.com/usage-table
  hacks.noblob = false
  if (/^Mozilla\/5.0 \(iPhone; CPU iPhone OS 12_[0-9]_[0-9] like Mac OS X\)/.test(navigator.userAgent)) {
    hacks.noblob = true
    hacks.nosw = true
    console.log('quirks: using ios12 dataurl hack')
  }

  // Work around iOS trying to connect when the link is previewed.
  // You never saw this.
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) &&
      ![320, 375, 414, 768, 1024].includes(window.innerWidth)) {
    hacks.noautoconnect = true
    console.log('quirks: detected preview, ')
  }

  // Detect for features we need for this to work.
  if (!(window.WebSocket) ||
      !(window.RTCPeerConnection) ||
      !(window.WebAssembly)) {
    hacks.browserunsupported = true
  }

  // Are we in an extension?
  hacks.wasmURL = 'webwormhole.wasm'
  if (window.chrome && chrome.runtime && chrome.runtime.getURL){
    const resourceURL = chrome.runtime.getURL('')
    if (resourceURL.startsWith('moz')) {
      console.log('quirks: firefox extension, no serviceworkers')
      hacks.nosw = true
    } else if (resourceURL.startsWith('chrome')) {
      console.log('quirks: chrome extension')
      hacks.wasmURL = chrome.runtime.getURL('webwormhole.wasm')
    } else {
      console.log('quirks: unknown browser extension')
    }
    signalserver = new URL('https://webwormhole.io/')
  }
}

const domready = async () => {
  return new Promise(resolve => { document.addEventListener('DOMContentLoaded', resolve) })
}

const swready = async () => {
  if (!hacks.nosw) {
    const registration = await navigator.serviceWorker.register('sw.js', { scope: '/_/' })
    // TODO handle updates to service workers.
    serviceworker = registration.active || registration.waiting || registration.installing
    console.log('service worker registered:', serviceworker.state)
  }
}

const wasmready = async () => {
  if (!hacks.nowasm) {
    const go = new Go()
    const wasm = await WebAssembly.instantiateStreaming(fetch(hacks.wasmURL), go.importObject)
    go.run(wasm.instance)
  }
}

(async () => {
  // Detect Browser Quirks.
  browserhacks()

  // Wait for the ServiceWorker, WebAssembly, and DOM to be ready.
  await Promise.all([domready(), swready(), wasmready()])

  if (hacks.browserunsupported) {
    document.getElementById('info').innerHTML = 'Browser missing required feature. This application needs support for WebSockets, WebRTC, and WebAssembly.'
    document.body.classList.add('error')
    return
  }

  // Install event handlers. If we start to allow queueing files before
  // connections we might want to move these into domready so as to not
  // block them.
  window.addEventListener('hashchange', hashchange)
  document.getElementById('magiccode').addEventListener('input', codechange)
  document.getElementById('magiccode').addEventListener('keydown', autocomplete)
  document.getElementById('magiccode').addEventListener('input', autocompletehint)
  document.getElementById('filepicker').addEventListener('change', pick)
  document.getElementById('dialog').addEventListener('submit', preventdefault)
  document.getElementById('dialog').addEventListener('submit', connect)
  document.body.addEventListener('drop', preventdefault)
  document.body.addEventListener('dragenter', preventdefault)
  document.body.addEventListener('dragover', preventdefault)
  document.body.addEventListener('drop', preventdefault)
  document.body.addEventListener('dragleave', preventdefault)
  document.body.addEventListener('drop', drop)
  document.body.addEventListener('dragenter', highlight)
  document.body.addEventListener('dragover', highlight)
  document.body.addEventListener('drop', unhighlight)
  document.body.addEventListener('dragleave', unhighlight)

  if (location.hash.substring(1) !== '') {
    document.getElementById('magiccode').value = location.hash.substring(1)
  }
  codechange() // User might have typed something while we were loading.
  document.getElementById('dial').disabled = false

  if (!hacks.noautoconnect && document.getElementById('magiccode').value !== '') {
    connect()
  }
})()
