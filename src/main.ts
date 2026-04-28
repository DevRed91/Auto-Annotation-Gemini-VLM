import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!

// Simulate loading
setTimeout(() => {
  app.innerHTML = `
    <section class="hero-section">
      <h1>WorldLab-Int</h1>
      <p>The future of Gaussian Splatting and 3D visualization. Advanced interaction lab for neural rendering.</p>
      <button class="btn">Explore Lab</button>
    </section>
  `
}, 1500)

console.log('WorldLab-Int Initialized')
