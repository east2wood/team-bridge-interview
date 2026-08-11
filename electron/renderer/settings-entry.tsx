import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPage } from './SettingsPage'
import './settings.css'

const root = document.getElementById('root')
if (!root) throw new Error('settings root element is missing')

createRoot(root).render(
  <StrictMode>
    <SettingsPage />
  </StrictMode>,
)
