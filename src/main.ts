import './style.css'
import './script.ts'
import { loadWorld } from './script'
import { WorldLabsService } from './worldlabs'

const app = document.querySelector<HTMLDivElement>('#app')!

// Initial Landing UI
app.innerHTML = `
  <div class="loader-container">
    <div class="loader"></div>
    <p>Initializing WorldLab-Int...</p>
  </div>
`

setTimeout(() => {
  renderMainUI()
}, 1000)

function renderMainUI() {
  app.innerHTML = `
    <section class="hero-section" id="hero">
      <h1>WorldLab-Int</h1>
      <p>The future of Gaussian Splatting. Generate immersive 3D worlds with natural language using World Labs Marble API.</p>
      <button class="btn" id="start-btn">Get Started</button>
    </section>

    <div class="controls-panel hidden" id="controls">
      <div class="input-group">
        <label for="api-key">Marble API Key</label>
        <input type="password" id="api-key" placeholder="Enter your WLT-Api-Key..." value="${process.env.API_KEY || ''}" />
      </div>
      
      <div class="input-group">
        <label>Input Type</label>
        <div style="display: flex; gap: 10px;">
          <button class="btn" style="flex: 1; margin-top: 0; background: var(--glass-bg);" id="type-text">Text</button>
          <button class="btn" style="flex: 1; margin-top: 0; background: var(--glass-bg);" id="type-image">Image</button>
        </div>
      </div>

      <div class="input-group" id="text-input-group">
        <label for="prompt">World Prompt</label>
        <input type="text" id="prompt" placeholder="e.g. A mystical forest with glowing mushrooms" />
      </div>

      <div class="input-group hidden" id="image-input-group">
        <label for="image-file">Source Image</label>
        <input type="file" id="image-file" accept="image/*" style="padding: 10px; background: rgba(255,255,255,0.05); border-radius: 12px; border: 1px solid var(--glass-border); color: white;" />
      </div>

      <button class="btn-generate" id="generate-btn">
        <span>Generate World</span>
      </button>
      <div class="status-text" id="status">Ready to generate</div>
    </div>
  `

  const startBtn = document.getElementById('start-btn')!
  const hero = document.getElementById('hero')!
  const controls = document.getElementById('controls')!
  const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement
  const apiKeyInput = document.getElementById('api-key') as HTMLInputElement
  const promptInput = document.getElementById('prompt') as HTMLInputElement
  const imageInput = document.getElementById('image-file') as HTMLInputElement
  const statusText = document.getElementById('status')!
  
  const typeTextBtn = document.getElementById('type-text')!
  const typeImageBtn = document.getElementById('type-image')!
  const textInputGroup = document.getElementById('text-input-group')!
  const imageInputGroup = document.getElementById('image-input-group')!

  let currentType: 'text' | 'image' = 'text'

  typeTextBtn.addEventListener('click', () => {
    currentType = 'text'
    textInputGroup.classList.remove('hidden')
    imageInputGroup.classList.add('hidden')
    typeTextBtn.style.background = 'var(--accent-color)'
    typeImageBtn.style.background = 'var(--glass-bg)'
  })

  typeImageBtn.addEventListener('click', () => {
    currentType = 'image'
    imageInputGroup.classList.remove('hidden')
    textInputGroup.classList.add('hidden')
    typeImageBtn.style.background = 'var(--accent-color)'
    typeTextBtn.style.background = 'var(--glass-bg)'
  })

  // Set initial active button
  typeTextBtn.style.background = 'var(--accent-color)'

  startBtn.addEventListener('click', () => {
    hero.classList.add('hidden')
    controls.classList.remove('hidden')
  })

  generateBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim()
    if (!apiKey) {
      statusText.innerText = 'Please enter an API key'
      return
    }

    try {
      generateBtn.disabled = true
      generateBtn.innerText = 'Initializing...'
      
      const service = new WorldLabsService()
      // Override API key if provided in input
      if (apiKey) (service as any).apiKey = apiKey

      let splatUrl = ''

      if (currentType === 'text') {
        const prompt = promptInput.value.trim()
        if (!prompt) {
          statusText.innerText = 'Please enter a prompt'
          generateBtn.disabled = false
          return
        }
        statusText.innerText = 'Submitting text request...'
        splatUrl = await service.generateWorld(prompt)
      } else {
        const file = imageInput.files?.[0]
        if (!file) {
          statusText.innerText = 'Please select an image file'
          generateBtn.disabled = false
          return
        }
        statusText.innerText = 'Uploading image to World Labs...'
        const assetId = await service.uploadMedia(file)
        
        statusText.innerText = 'Generating world from image...'
        splatUrl = await service.generateWorldFromImage(assetId)
      }
      
      statusText.innerText = 'Generation complete! Loading world...'
      await loadWorld(splatUrl)
      
      statusText.innerText = 'World loaded successfully'
    } catch (error: any) {
      console.error(error)
      statusText.innerText = `Error: ${error.message}`
    } finally {
      generateBtn.disabled = false
      generateBtn.innerText = 'Generate World'
    }
  })
}
