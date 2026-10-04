import React, { useRef, useEffect, useState } from 'react';
import { CENTRAL_API_BASE, USE_MOCK_DATA } from '../../config';


const RealGradCam = ({ showOverlay, caseData, onLoadError }) => {
  const imageSrc = `${CENTRAL_API_BASE}${caseData.imageUrl}`;
  const overlaySrc = caseData.gradCamOverlayUrl ? `${CENTRAL_API_BASE}${caseData.gradCamOverlayUrl}` : null;

  return (
    <div>
      <div className="gradcam-viewer">
        <img src={imageSrc} alt="Fundus capture" className="gradcam-viewer__fundus" onError={onLoadError} />
        {overlaySrc && (
          // A complete, pre-blended image (fundus + heatmap), not a
          // transparent layer -- see the CSS comment on .gradcam-viewer__overlay.
          <img
            src={overlaySrc}
            alt="Grad-CAM attention overlay"
            className={`gradcam-viewer__overlay ${showOverlay ? 'gradcam-viewer__overlay--visible' : ''}`}
          />
        )}
        <div className="capture-zone__crosshair" />
        <div className="gradcam-viewer__brackets">
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--tl" />
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--tr" />
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--bl" />
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--br" />
        </div>
      </div>
      {showOverlay && overlaySrc && (
        <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55, marginTop: 6, textAlign: 'center' }}>
          Grad-CAM view shows the model's own cropped working image, not the original capture — the crop can look tighter or offset from the photo above.
        </p>
      )}
    </div>
  );
};

/**
 * SyntheticGradCam renders a synthetic fundus image and a Grad-CAM heatmap
 * overlay. Used when there is no real image to show (mock data, or a case
 * whose grading hasn't produced media yet).
 */
const SyntheticGradCam = ({ showOverlay, caseData }) => {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const [dimensions] = useState({ width: 500, height: 500 });

  // Draw synthetic fundus
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width, height } = dimensions;
    canvas.width = width;
    canvas.height = height;

    // Background — dark retinal field
    const grad = ctx.createRadialGradient(width / 2, height / 2, 50, width / 2, height / 2, 280);
    grad.addColorStop(0, '#8B3A1A');
    grad.addColorStop(0.4, '#5C1A0A');
    grad.addColorStop(0.7, '#2A0A02');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Optic disc
    const discGrad = ctx.createRadialGradient(210, 250, 5, 210, 250, 35);
    discGrad.addColorStop(0, '#FFD699');
    discGrad.addColorStop(0.5, '#FFAA44');
    discGrad.addColorStop(1, '#CC7722');
    ctx.beginPath();
    ctx.arc(210, 250, 30, 0, Math.PI * 2);
    ctx.fillStyle = discGrad;
    ctx.fill();

    // Fovea
    const foveaGrad = ctx.createRadialGradient(300, 250, 2, 300, 250, 18);
    foveaGrad.addColorStop(0, '#1A0500');
    foveaGrad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(300, 250, 18, 0, Math.PI * 2);
    ctx.fillStyle = foveaGrad;
    ctx.fill();

    // Blood vessels
    ctx.strokeStyle = '#661111';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    const drawVessel = (points) => {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      ctx.stroke();
    };

    // Major vessels from optic disc
    drawVessel([[210, 250], [230, 200], [260, 160], [300, 130], [350, 110]]);
    drawVessel([[210, 250], [230, 300], [260, 340], [300, 370], [350, 390]]);
    drawVessel([[210, 250], [250, 240], [310, 230], [370, 220]]);
    drawVessel([[210, 250], [250, 260], [310, 270], [370, 280]]);

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#551111';
    drawVessel([[260, 160], [280, 140], [310, 125]]);
    drawVessel([[260, 340], [280, 360], [310, 375]]);
    drawVessel([[310, 230], [330, 210], [355, 195]]);
    drawVessel([[310, 270], [330, 290], [355, 305]]);

    // Microaneurysms (small red dots)
    const lesionCount = caseData?.lesionCounts?.microaneurysms || 0;
    const maPositions = [
      [280, 180], [310, 195], [340, 170],
      [290, 310], [320, 330], [350, 340],
      [270, 220], [350, 250], [380, 200],
    ];
    ctx.fillStyle = '#CC2222';
    for (let i = 0; i < Math.min(lesionCount, maPositions.length); i++) {
      ctx.beginPath();
      ctx.arc(maPositions[i][0], maPositions[i][1], 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hemorrhages (larger dark patches)
    const hemCount = caseData?.lesionCounts?.hemorrhages || 0;
    const hemPositions = [
      [290, 200, 8], [330, 300, 10], [260, 290, 7],
      [350, 230, 9], [300, 350, 8],
    ];
    ctx.fillStyle = 'rgba(100, 10, 10, 0.7)';
    for (let i = 0; i < Math.min(hemCount, hemPositions.length); i++) {
      ctx.beginPath();
      ctx.arc(hemPositions[i][0], hemPositions[i][1], hemPositions[i][2], 0, Math.PI * 2);
      ctx.fill();
    }

    // Hard exudates (yellowish spots)
    const exCount = caseData?.lesionCounts?.hardExudates || 0;
    const exPositions = [
      [310, 240, 4], [320, 260, 5], [295, 265, 3],
      [330, 245, 4], [340, 260, 3],
    ];
    ctx.fillStyle = 'rgba(255, 220, 100, 0.6)';
    for (let i = 0; i < Math.min(exCount, exPositions.length); i++) {
      ctx.beginPath();
      ctx.arc(exPositions[i][0], exPositions[i][1], exPositions[i][2], 0, Math.PI * 2);
      ctx.fill();
    }

    // Circular mask for retinal field
    ctx.globalCompositeOperation = 'destination-in';
    const maskGrad = ctx.createRadialGradient(width / 2, height / 2, 150, width / 2, height / 2, 230);
    maskGrad.addColorStop(0, 'rgba(0,0,0,1)');
    maskGrad.addColorStop(0.8, 'rgba(0,0,0,1)');
    maskGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = maskGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }, [dimensions, caseData]);

  const [opacity, setOpacity] = useState(0.75);
  const [overlayMode, setOverlayMode] = useState('jet'); // 'jet' | 'contour' | 'centroids'

  // Draw Grad-CAM overlay
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width, height } = dimensions;
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    if (!showOverlay) return;

    // Hotspots — areas of high attention
    const hotspots = [
      { x: 290, y: 190, r: 52, intensity: 0.9 },
      { x: 320, y: 310, r: 44, intensity: 0.85 },
      { x: 340, y: 250, r: 58, intensity: 0.65 },
      { x: 270, y: 280, r: 36, intensity: 0.7 },
      { x: 310, y: 195, r: 28, intensity: 0.95 },
    ];

    if (overlayMode === 'jet') {
      hotspots.forEach(spot => {
        const grad = ctx.createRadialGradient(spot.x, spot.y, 0, spot.x, spot.y, spot.r);
        grad.addColorStop(0, `rgba(230, 20, 20, ${spot.intensity * opacity})`);
        grad.addColorStop(0.35, `rgba(255, 110, 0, ${spot.intensity * opacity * 0.75})`);
        grad.addColorStop(0.7, `rgba(255, 220, 0, ${spot.intensity * opacity * 0.4})`);
        grad.addColorStop(1, 'rgba(0, 50, 200, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      });
    } else if (overlayMode === 'contour') {
      hotspots.forEach(spot => {
        ctx.strokeStyle = `rgba(255, 220, 50, ${opacity})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(spot.x, spot.y, spot.r * 0.7, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(255, 50, 50, ${opacity * 0.8})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(spot.x, spot.y, spot.r * 0.4, 0, Math.PI * 2);
        ctx.stroke();
      });
    } else {
      // Centroids mode
      hotspots.forEach(spot => {
        ctx.fillStyle = `rgba(255, 40, 40, ${opacity})`;
        ctx.beginPath();
        ctx.arc(spot.x, spot.y, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    // Circular mask
    ctx.globalCompositeOperation = 'destination-in';
    const maskGrad = ctx.createRadialGradient(width / 2, height / 2, 150, width / 2, height / 2, 230);
    maskGrad.addColorStop(0, 'rgba(0,0,0,1)');
    maskGrad.addColorStop(0.8, 'rgba(0,0,0,1)');
    maskGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = maskGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }, [showOverlay, dimensions, opacity, overlayMode]);

  return (
    <div>
      <div className="gradcam-viewer" style={{ position: 'relative' }}>
        <canvas ref={canvasRef} className="gradcam-viewer__fundus" />
        <canvas
          ref={overlayRef}
          className={`gradcam-viewer__overlay ${showOverlay ? 'gradcam-viewer__overlay--visible' : ''}`}
        />
        {/* Crosshair */}
        <div className="capture-zone__crosshair" />
        {/* Corner brackets */}
        <div className="gradcam-viewer__brackets">
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--tl" />
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--tr" />
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--bl" />
          <span className="gradcam-viewer__bracket gradcam-viewer__bracket--br" />
        </div>
      </div>

      {showOverlay && (
        <div style={{
          marginTop: '12px',
          padding: '10px 14px',
          background: 'rgba(10, 10, 10, 0.85)',
          border: '1px solid var(--c-crimson)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="t-mono" style={{ fontSize: '11px', color: 'var(--c-crimson)', fontWeight: 700 }}>
              HEATMAP OPACITY:
            </span>
            <input
              type="range"
              min="0.2"
              max="1.0"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              style={{ width: '90px', accentColor: 'var(--c-crimson)', cursor: 'pointer' }}
            />
            <span className="t-mono" style={{ fontSize: '11px', opacity: 0.8 }}>
              {Math.round(opacity * 100)}%
            </span>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              className={`badge ${overlayMode === 'jet' ? 'badge--fail' : 'badge--neutral'}`}
              style={{ cursor: 'pointer', padding: '3px 8px', fontSize: '10px' }}
              onClick={() => setOverlayMode('jet')}
            >
              JET HEATMAP
            </button>
            <button
              type="button"
              className={`badge ${overlayMode === 'contour' ? 'badge--fail' : 'badge--neutral'}`}
              style={{ cursor: 'pointer', padding: '3px 8px', fontSize: '10px' }}
              onClick={() => setOverlayMode('contour')}
            >
              CONTOURS
            </button>
            <button
              type="button"
              className={`badge ${overlayMode === 'centroids' ? 'badge--fail' : 'badge--neutral'}`}
              style={{ cursor: 'pointer', padding: '3px 8px', fontSize: '10px' }}
              onClick={() => setOverlayMode('centroids')}
            >
              CENTROIDS
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** Live mode, no image to show: say why, in the space the image would take. */
const NoImage = ({ title, detail }) => (
  <div className="gradcam-viewer" role="alert" style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    background: 'var(--c-black, #1A1008)', color: 'var(--c-cream, #F5EDE0)', padding: 'var(--sp-6, 24px)',
    textAlign: 'center', fontFamily: 'var(--font-mono, monospace)', minHeight: 320,
  }}>
    <div style={{ color: 'var(--c-crimson, #C42B2B)', fontWeight: 700, letterSpacing: '1px' }}>{title}</div>
    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8, maxWidth: 360 }}>{detail}</div>
  </div>
);

/**
 * GradCamOverlay — the real fundus image and Grad-CAM overlay when the case has
 * them. The procedurally drawn synthetic retina is a mock-mode illustration
 * ONLY: in live mode a case with no image, or an image that fails to load,
 * says so instead — a made-up heatmap next to a real grade would be a
 * fabricated result (design doc §1.22).
 */
export const GradCamOverlay = ({ showOverlay, caseData }) => {
  const [realImageFailed, setRealImageFailed] = useState(false);

  if (caseData?.imageUrl && !realImageFailed) {
    return (
      <RealGradCam
        showOverlay={showOverlay}
        caseData={caseData}
        onLoadError={() => setRealImageFailed(true)}
      />
    );
  }
  if (USE_MOCK_DATA) {
    return <SyntheticGradCam showOverlay={showOverlay} caseData={caseData} />;
  }
  return realImageFailed
    ? <NoImage title="FUNDUS IMAGE FAILED TO LOAD"
      detail={`${caseData.imageUrl} could not be fetched from the central server. Check that it is running and that you are signed in, then reload.`} />
    : <NoImage title="NO FUNDUS IMAGE ON THIS CASE"
      detail="The case has no stored image yet (not graded, or grading failed). No attention map can be shown." />;
};
