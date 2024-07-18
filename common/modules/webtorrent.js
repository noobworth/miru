import { spawn } from 'node:child_process'
import WebTorrent from 'webtorrent'
import HTTPTracker from 'bittorrent-tracker/lib/client/http-tracker.js'
import { hex2bin, arr2hex, text2arr } from 'uint8-util'
import Parser from './parser.js'
import { defaults, fontRx, subRx, videoRx } from './util.js'
import { SUPPORTS } from '@/modules/support.js'

// HACK: this is https only, but electron doesnt run in https, weirdge
if (!globalThis.FileSystemFileHandle) globalThis.FileSystemFileHandle = false

const announce = [
  atob('d3NzOi8vdHJhY2tlci5vcGVud2VidG9ycmVudC5jb20='),
  atob('d3NzOi8vdHJhY2tlci53ZWJ0b3JyZW50LmRldg=='),
  atob('d3NzOi8vdHJhY2tlci5maWxlcy5mbTo3MDczL2Fubm91bmNl'),
  atob('d3NzOi8vdHJhY2tlci5idG9ycmVudC54eXov'),
  atob('dWRwOi8vb3Blbi5zdGVhbHRoLnNpOjgwL2Fubm91bmNl'),
  atob('aHR0cDovL255YWEudHJhY2tlci53Zjo3Nzc3L2Fubm91bmNl'),
  atob('dWRwOi8vdHJhY2tlci5vcGVudHJhY2tyLm9yZzoxMzM3L2Fubm91bmNl'),
  atob('dWRwOi8vZXhvZHVzLmRlc3luYy5jb206Njk2OS9hbm5vdW5jZQ=='),
  atob('dWRwOi8vdHJhY2tlci5jb3BwZXJzdXJmZXIudGs6Njk2OS9hbm5vdW5jZQ=='),
  atob('dWRwOi8vOS5yYXJiZy50bzoyNzEwL2Fubm91bmNl'),
  atob('dWRwOi8vdHJhY2tlci50b3JyZW50LmV1Lm9yZzo0NTEvYW5ub3VuY2U='),
  atob('aHR0cDovL29wZW4uYWNnbnh0cmFja2VyLmNvbTo4MC9hbm5vdW5jZQ=='),
  atob('aHR0cDovL2FuaWRleC5tb2U6Njk2OS9hbm5vdW5jZQ=='),
  atob('aHR0cDovL3RyYWNrZXIuYW5pcmVuYS5jb206ODAvYW5ub3VuY2U=')
]

let storedSettings = {}

try {
  storedSettings = JSON.parse(localStorage.getItem('settings')) || {}
} catch (error) {}

export default class TorrentClient extends WebTorrent {
  static excludedErrorMessages = ['WebSocket', 'User-Initiated Abort, reason=', 'Connection failed.']

  player = ''
  /** @type {ReturnType<spawn>} */
  playerProcess = null
  torrentPath = ''

  ipc

  constructor (ipc, storageQuota, serverMode, torrentPath, controller) {
    const settings = { ...defaults, ...storedSettings }
    super({
      dht: !settings.torrentDHT,
      maxConns: settings.maxConns,
      downloadLimit: settings.torrentSpeed * 1048576 || 0,
      uploadLimit: settings.torrentSpeed * 1572864 || 0, // :trolled:
      torrentPort: settings.torrentPort || 0,
      dhtPort: settings.dhtPort || 0,
      natUpnp: SUPPORTS.permamentNAT ? 'permanent' : true
    })
    this.ipc = ipc
    this.torrentPath = torrentPath
    this._ready = new Promise(resolve => {
      ipc.on('port', ({ ports }) => {
        this.message = ports[0].postMessage.bind(ports[0])
        ports[0].onmessage = ({ data }) => {
          if (data.type === 'load') this.loadLastTorrent(data.data)
          if (data.type === 'destroy') this.destroy()
          this.handleMessage({ data })
        }
        resolve()
      })
      ipc.on('destroy', this.destroy.bind(this))
    })
    ipc.on('player', (event, data) => {
      this.player = data
    })
    ipc.on('torrentPath', (event, data) => {
      this.torrentPath = data
    })
    this.settings = settings

    this.serverMode = serverMode
    this.storageQuota = storageQuota

    this.current = null
    this.parsed = false

    setInterval(() => {
      this.dispatch('stats', {
        numPeers: (this.torrents.length && this.torrents[0].numPeers) || 0,
        uploadSpeed: (this.torrents.length && this.torrents[0].uploadSpeed) || 0,
        downloadSpeed: (this.torrents.length && this.torrents[0].downloadSpeed) || 0
      })
    }, 200)
    setInterval(() => {
      if (this.torrents[0]?.pieces) this.dispatch('progress', this.current?.progress)
    }, 2000)
    this.on('torrent', this.handleTorrent.bind(this))

    const createServer = controller => {
      this.server = this.createServer({ controller }, serverMode)
      this.server.listen(0, () => {})
    }

    if (controller) {
      controller.then(createServer)
    } else {
      createServer()
    }

    this.trackers = {
      cat: new HTTPTracker({}, atob('aHR0cDovL255YWEudHJhY2tlci53Zjo3Nzc3L2Fubm91bmNl'))
    }

    process.on('uncaughtException', this.dispatchError.bind(this))
    this.on('error', this.dispatchError.bind(this))
  }

  loadLastTorrent (t) {
    if (!t) return
    let torrent
    // this can be a magnet string, or a stringified array, lazy way of makign sure it works
    try {
      const parsed = JSON.parse(t)
      if (typeof parsed === 'string') {
        torrent = parsed
      } else {
        torrent = new Uint8Array(parsed)
      }
    } catch (e) {
      torrent = t
    }
    if (torrent) this.addTorrent(torrent, JSON.parse(localStorage.getItem('lastFinished')))
  }

  async handleTorrent (torrent) {
    const files = torrent.files.map(file => {
      return {
        infoHash: torrent.infoHash,
        name: file.name,
        type: file.type,
        size: file.size,
        path: file.path,
        url: this.serverMode === 'node' ? 'http://localhost:' + this.server.address().port + file.streamURL : file.streamURL
      }
    })
    this.dispatch('files', files)
    this.dispatch('magnet', { magnet: torrent.magnetURI, hash: torrent.infoHash })
    localStorage.setItem('torrent', JSON.stringify([...torrent.torrentFile])) // this won't work on mobile, but really it only speeds stuff up by ~1-2 seconds since magnet data doesn't need to be resolved
  }

  async findFontFiles (targetFile) {
    const files = this.torrents[0].files
    const fontFiles = files.filter(file => fontRx.test(file.name))

    const map = {}

    // deduplicate fonts
    // some releases have duplicate fonts for diff languages
    // if they have different chars, we can't find that out anyways
    // so some chars might fail, on REALLY bad releases
    for (const file of fontFiles) {
      map[file.name] = file
    }

    for (const file of Object.values(map)) {
      const data = await file.arrayBuffer()
      if (targetFile !== this.current) return
      this.dispatch('file', { data: new Uint8Array(data) }, [data])
    }
  }

  async findSubtitleFiles (targetFile) {
    const files = this.torrents[0].files
    const videoFiles = files.filter(file => videoRx.test(file.name))
    const videoName = targetFile.name.substring(0, targetFile.name.lastIndexOf('.')) || targetFile.name
    // array of subtitle files that match video name, or all subtitle files when only 1 vid file
    const subfiles = files.filter(file => {
      return subRx.test(file.name) && (videoFiles.length === 1 ? true : file.name.includes(videoName))
    })
    for (const file of subfiles) {
      const data = await file.arrayBuffer()
      if (targetFile !== this.current) return
      this.dispatch('subtitleFile', { name: file.name, data: new Uint8Array(data) }, [data])
    }
  }

  _scrape ({ id, infoHashes }) {
    this.trackers.cat._request(this.trackers.cat.scrapeUrl, { info_hash: infoHashes.map(infoHash => hex2bin(infoHash)) }, (err, data) => {
      if (err) {
        const error = this._errorToString(err)
        this.dispatch('warn', `Failed to update seeder counts: ${error}`)
        return this.dispatch('scrape', { id, result: [] })
      }
      const { files } = data
      const result = []
      for (const [key, data] of Object.entries(files || {})) {
        result.push({ hash: key.length !== 40 ? arr2hex(text2arr(key)) : key, ...data })
      }
      this.dispatch('scrape', { id, result })
    })
  }

  _errorToString (e) {
    if (typeof Event !== 'undefined' && e instanceof Event) {
      if (e.error) return this._errorToString(e.error)
      if (e.message) return this._errorToString(e.message)
      if (e.reason) return this._errorToString(e.reason)
      return JSON.stringify(e)
    }
    if (typeof Error !== 'undefined' && e instanceof Error) {
      if (e.message) return this._errorToString(e.message)
      if (e.cause) return this._errorToString(e.cause)
      if (e.reason) return this._errorToString(e.reason)
      if (e.name) return this._errorToString(e.name)
      return JSON.stringify(e)
    }
    if (typeof e !== 'string') return JSON.stringify(e)
    return e
  }

  dispatchError (e) {
    const error = this._errorToString(e)
    for (const exclude of TorrentClient.excludedErrorMessages) {
      if (error.startsWith(exclude)) return
    }
    console.error(error)
    this.dispatch('error', error)
  }

  async addTorrent (data, skipVerify = false) {
    const existing = await this.get(data)
    if (existing) {
      if (existing.ready) this.handleTorrent(existing)
      return
    }
    localStorage.setItem('lastFinished', 'false')
    if (this.torrents.length) await this.remove(this.torrents[0])
    const torrent = await this.add(data, {
      private: this.settings.torrentPeX,
      path: this.torrentPath || undefined,
      destroyStoreOnDestroy: !this.settings.torrentPersist,
      skipVerify,
      announce,
      deselect: this.settings.torrentStreamedDownload
    })

    torrent.once('done', () => {
      if (SUPPORTS.torrentPersist && this.settings.torrentPath) localStorage.setItem('lastFinished', 'true')
    })
  }

  async handleMessage ({ data }) {
    switch (data.type) {
      case 'current': {
        if (data.data) {
          const torrent = await this.get(data.data.current.infoHash)
          if (!torrent || torrent.destroyed) return
          const found = torrent.files.find(file => file.path === data.data.current.path)
          if (!found || found._destroyed) return
          if (this.playerProcess) {
            this.playerProcess.kill()
            this.playerProcess = null
          }
          if (this.current) {
            this.current.removeAllListeners('stream')
            if (!this.current._destroyed) this.current.deselect()
          }
          this.parser?.destroy()
          found.select()
          if (found.length > await this.storageQuota(torrent.path)) {
            this.dispatchError('File Too Big! This File Exceeds The Selected Drive\'s Available Space. Change Download Location In Torrent Settings To A Drive With More Space And Restart The App!')
          }
          this.current = found
          if (data.data.external && this.player) {
            this.playerProcess = spawn(this.player, [encodeURI('http://localhost:' + this.server.address().port + found.streamURL)])
            this.playerProcess.stdout.on('data', () => {})
            const startTime = Date.now()
            this.playerProcess.once('close', () => {
              this.playerProcess = null
              const seconds = (Date.now() - startTime) / 1000
              this.dispatch('externalWatched', seconds)
            })
          } else {
            this.parser = new Parser(this, found)
            this.findSubtitleFiles(found)
            this.findFontFiles(found)
          }
        }
        break
      }
      case 'scrape': {
        this._scrape(data.data)
        break
      }
      case 'torrent': {
        this.addTorrent(data.data)
        break
      }
    }
  }

  async dispatch (type, data, transfer) {
    await this._ready
    this.message?.({ type, data }, transfer)
  }

  destroy () {
    if (this.destroyed) return
    this.parser?.destroy()
    this.server.close()
    super.destroy(() => {
      this.ipc.send('destroyed')
    })
  }
}
