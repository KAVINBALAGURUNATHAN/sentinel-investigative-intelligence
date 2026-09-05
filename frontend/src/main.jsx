import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './investigator/App.jsx'

// The original messaging dashboard is preserved at src/App.jsx and can be
// mounted by importing it here instead; it is left untouched.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
