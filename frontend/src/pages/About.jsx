import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAboutPage } from '../api'
import AppFooter from '../components/common/AppFooter'

export default function About() {
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    getAboutPage()
      .then(res => setHtml(res.data.html))
      .catch(err => console.error('Failed to load about page:', err))
      .finally(() => setLoading(false))
  }, [])

  const BackButton = () => (
    <button
      onClick={() => navigate('/')}
      className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-medium px-5 py-2.5 rounded-lg shadow-sm transition-colors text-sm"
    >
      <span>&larr; Back to Projects</span>
    </button>
  )

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6 flex justify-center">
          <BackButton />
        </div>

        {loading ? (
          <div className="text-center text-gray-500 py-12">Loading...</div>
        ) : (
          <div
            className="about-content text-gray-700 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        <div className="mt-6 flex justify-center">
          <BackButton />
        </div>
        <AppFooter />
      </div>
    </div>
  )
}
