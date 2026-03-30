import { useState } from 'react';
import './RatingStars.css';

/** Click-to-set star rating widget (0–5 stars). */
export default function RatingStars({ value = 0, onChange, readOnly = false }) {
  const [hovered, setHovered] = useState(0);

  const display = hovered > 0 ? hovered : (value ?? 0);

  return (
    <span className={`rating-stars${readOnly ? ' rating-stars--readonly' : ''}`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          className={`rating-star${display >= star ? ' rating-star--filled' : ''}`}
          onMouseEnter={() => !readOnly && setHovered(star)}
          onMouseLeave={() => !readOnly && setHovered(0)}
          onClick={() => {
            if (readOnly) return;
            // Clicking the current rating toggles it off (sets to 0)
            onChange?.(value === star ? 0 : star);
          }}
          title={readOnly ? `${value ?? 0}/5` : `Set rating to ${star}`}
        >
          ★
        </span>
      ))}
    </span>
  );
}
