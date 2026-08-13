import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LiveInterview } from './LiveInterview'
import './live.css'

const root = document.getElementById('root')
if (!root) throw new Error('live root element is missing')

createRoot(root).render(
  <StrictMode>
    <LiveInterview />
  </StrictMode>,
)
