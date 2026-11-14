// Serves a Matterport Showcase SDK smoke page on localhost (the only domain our SDK key allows):
// `pnpm showcase`, then open http://localhost:8000/showcase/?m=<modelId>.
import { createServer } from 'node:http'

const PORT = 8000
const sdkKey = process.env.MP_SDK_KEY
if (!sdkKey) throw new Error('MP_SDK_KEY is missing from .env')

const page = (modelId: string) => `<!doctype html>
<meta charset="utf-8">
<title>Showcase ${modelId}</title>
<style>
  body { margin: 0; font: 14px system-ui; background: #111; color: #eee }
  iframe { width: 100vw; height: calc(100vh - 2.5em); border: 0; display: block }
  #status { padding: .6em 1em; height: 1.3em }
</style>
<div id="status">Connecting to Showcase SDK…</div>
<iframe id="showcase" src="https://my.matterport.com/show?m=${modelId}&play=1&applicationKey=${sdkKey}" allow="fullscreen; xr-spatial-tracking"></iframe>
<script type="module">
  import { connect } from 'https://api.matterport.com/sdk/bootstrap/3.1.0-0-g1cd7e0997a/sdk.es6.js?applicationKey=${sdkKey}'
  const status = document.getElementById('status')
  try {
    const sdk = await connect(document.getElementById('showcase'))
    const model = await sdk.Model.getData()
    window.sdk = sdk
    sdk.Sweep.current.subscribe((sweep) => {
      status.textContent = 'SDK connected · model ' + model.sid + ' · sweep ' + (sweep.sid || '…') + ' · window.sdk is live in the console'
    })
  } catch (error) {
    status.textContent = 'SDK failed: ' + error
    console.error(error)
  }
</script>`

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const modelId = url.searchParams.get('m')
  if (url.pathname !== '/showcase/' || !modelId || !/^\w+$/.test(modelId)) {
    res.writeHead(404).end('Open /showcase/?m=<modelId>')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(page(modelId))
}).listen(PORT, 'localhost', () => console.log(`Showcase: http://localhost:${PORT}/showcase/?m=<modelId>`))
