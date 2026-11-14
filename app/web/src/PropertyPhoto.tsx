import { ImageOff } from 'lucide-react'
import { useState } from 'react'
import type { Property } from '../../shared/property'
import { thumbUrl } from './api'

// Shows the listing photo, then the aerial thumb when the photo fails, then a quiet placeholder.
export function PropertyPhoto({ property }: { property: Property }) {
  const sources = [property.photoUrl, thumbUrl(property.id)].filter((s) => s !== null)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const src = sources[attempt]

  return (
    <span className="photo">
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          className={loaded ? 'loaded' : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false)
            setAttempt((a) => a + 1)
          }}
        />
      ) : (
        <span className="photo-empty">
          <ImageOff size={20} />
        </span>
      )}
    </span>
  )
}
