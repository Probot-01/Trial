import React, { useMemo } from 'react';


export const EyeHeroSVG = ({ progress = 0, chapter = 0, chapterProgress = 0 }) => {
  const CX = 320;
  const CY = 212;
  const IRIS_R = 80;
  const LIMBUS_R = 84;


  const pupilR = track(progress, [[0, 28], [0.24, 20], [0.5, 16], [0.74, 30], [1, 42]]);

  const measureOpacity = fade(chapter, chapterProgress, 1) * 0.9;
  const networkOpacity = fade(chapter, chapterProgress, 3);

  // The fundus comes up through the widening pupil rather than switching on.
  const fundus = smoothstep(0.52, 0.78, progress);

  // Retinopathy arrives in the order a grader meets it.
  const dr = {
    microaneurysms: smoothstep(0.6, 0.7, progress),
    haemorrhages: smoothstep(0.7, 0.79, progress),
    exudates: smoothstep(0.78, 0.87, progress),
    cottonWool: smoothstep(0.85, 0.93, progress),
    neovascular: smoothstep(0.92, 1, progress),
  };

  // ── Iris stroma ──────────────────────────────────────────────────
  const iris = useMemo(() => {
    const rand = mulberry32(20260924);
    const fibres = [];
    for (let i = 0; i < 220; i++) {
      const a = (i / 220) * Math.PI * 2 + rand() * 0.03;
      const inner = 24 + rand() * 7;
      const outer = IRIS_R * (0.8 + rand() * 0.2);
      const bow = (rand() - 0.5) * 0.16;
      const mid = (inner + outer) * 0.5;
      fibres.push({
        d:
          'M ' + (Math.cos(a) * inner).toFixed(1) + ' ' + (Math.sin(a) * inner).toFixed(1) +
          ' Q ' + (Math.cos(a + bow) * mid).toFixed(1) + ' ' + (Math.sin(a + bow) * mid).toFixed(1) +
          ' ' + (Math.cos(a) * outer).toFixed(1) + ' ' + (Math.sin(a) * outer).toFixed(1),
        light: rand() < 0.44,
        w: 0.4 + rand() * 1.4,
        o: 0.1 + rand() * 0.45,
      });
    }
    const crypts = [];
    for (let i = 0; i < 20; i++) {
      const a = rand() * Math.PI * 2;
      const d = 36 + rand() * 28;
      crypts.push({
        cx: Math.cos(a) * d,
        cy: Math.sin(a) * d,
        rx: 3 + rand() * 7,
        ry: 1.6 + rand() * 3.4,
        rot: (a * 180) / Math.PI,
        o: 0.14 + rand() * 0.26,
      });
    }
    // The collarette: a wavy ruff where the pupillary zone meets the ciliary.
    let collarette = '';
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const r = 33 + Math.sin(a * 9) * 2.6 + Math.sin(a * 4.5) * 1.6;
      collarette += (i ? ' L ' : 'M ') + (Math.cos(a) * r).toFixed(1) + ' ' + (Math.sin(a) * r).toFixed(1);
    }
    return { fibres, crypts, collarette: collarette + ' Z' };
  }, []);

  // ── Episcleral vessels ───────────────────────────────────────────
  const vessels = useMemo(() => {
    const rand = mulberry32(77021);
    const out = [];
    for (let i = 0; i < 20; i++) {
      const fromLeft = i % 2 === 0;
      const x0 = fromLeft ? 76 + rand() * 30 : 564 - rand() * 30;
      const y0 = 150 + rand() * 130;
      const dir = fromLeft ? 1 : -1;
      const len = 90 + rand() * 130;
      let d = 'M ' + x0.toFixed(0) + ' ' + y0.toFixed(0);
      let x = x0;
      let y = y0;
      for (let k = 0; k < 4; k++) {
        const nx = x + dir * (len / 4);
        const ny = y + (rand() - 0.5) * 26;
        d += ' Q ' + (x + dir * (len / 8)).toFixed(0) + ' ' + (y + (rand() - 0.5) * 20).toFixed(0) +
          ' ' + nx.toFixed(0) + ' ' + ny.toFixed(0);
        x = nx;
        y = ny;
      }
      out.push({ d, w: 0.5 + rand() * 1.3, o: 0.18 + rand() * 0.4 });
    }
    return out;
  }, []);

  // ── Fundus: disc, arcades, macula, and the lesions ───────────────
  const retina = useMemo(() => {
    const rand = mulberry32(31337);
    const dots = (n, rMin, rMax, spread) => {
      const list = [];
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const d = Math.sqrt(rand()) * spread;
        list.push({
          cx: +(Math.cos(a) * d).toFixed(1),
          cy: +(Math.sin(a) * d).toFixed(1),
          r: +(rMin + rand() * (rMax - rMin)).toFixed(2),
        });
      }
      return list;
    };
    return {
      microaneurysms: dots(26, 0.5, 1.1, 24),
      haemorrhages: dots(12, 1.3, 2.6, 22),
      exudates: dots(18, 0.8, 2.1, 19),
      cottonWool: dots(5, 2.2, 3.6, 17),
    };
  }, []);

  const phcArcs = useMemo(() => ([
    { from: -62, to: 4, color: '#C42B2B' },
    { from: 18, to: 76, color: '#8A6A3C' },
    { from: 100, to: 156, color: '#C42B2B' },
    { from: 176, to: 232, color: '#8A6A3C' },
  ]), []);
  const vesselArt = useMemo(() => (
    <g className="eye-hero-svg__vessels" stroke="#C0574A" fill="none" strokeLinecap="round">
      {vessels.map((v, i) => (
        <path key={'v' + i} d={v.d} strokeWidth={v.w} opacity={v.o} />
      ))}
    </g>
  ), [vessels]);

  const irisArt = useMemo(() => (
    <g>
      {iris.fibres.map((f, i) => (
        <path
          key={'f' + i}
          d={f.d}
          fill="none"
          stroke={f.light ? '#EDE2CF' : '#2C2720'}
          strokeWidth={f.w}
          opacity={f.o}
          strokeLinecap="round"
        />
      ))}
      {/* One blur pass for all the crypts rather than twenty. */}
      <g filter="url(#eh-soft-xs)">
        {iris.crypts.map((c, i) => (
          <ellipse
            key={'c' + i}
            cx={c.cx}
            cy={c.cy}
            rx={c.rx}
            ry={c.ry}
            transform={'rotate(' + c.rot + ' ' + c.cx + ' ' + c.cy + ')'}
            fill="#221E19"
            opacity={c.o}
          />
        ))}
      </g>
      <path d={iris.collarette} fill="none" stroke="#EFE4CF" strokeWidth="2" opacity="0.38" />
      <path d={iris.collarette} fill="none" stroke="#221E19" strokeWidth="3" opacity="0.12" />
    </g>
  ), [iris]);

  const lesions = useMemo(() => ({
    microaneurysms: <g fill="#7E1408">{retina.microaneurysms.map((d, i) => (
      <circle key={'m' + i} cx={d.cx} cy={d.cy} r={d.r} />
    ))}</g>,
    haemorrhages: <g fill="#63120A">{retina.haemorrhages.map((d, i) => (
      <ellipse key={'h' + i} cx={d.cx} cy={d.cy} rx={d.r} ry={d.r * 0.72} opacity="0.9" />
    ))}</g>,
    exudates: <g fill="#F6DD9E">{retina.exudates.map((d, i) => (
      <ellipse key={'x' + i} cx={d.cx} cy={d.cy} rx={d.r} ry={d.r * 0.66} opacity="0.92" />
    ))}</g>,
    cottonWool: <g fill="#F3E4CB">{retina.cottonWool.map((d, i) => (
      <ellipse key={'w' + i} cx={d.cx} cy={d.cy} rx={d.r} ry={d.r * 0.6} opacity="0.7" />
    ))}</g>,
  }), [retina]);

  const lashes = useMemo(() => (
    <g stroke="#2B231C" strokeWidth="1.5" strokeLinecap="round" opacity="0.3">
      <path d="M 140 168 q -10 -12, -16 -22" />
      <path d="M 196 130 q -7 -14, -10 -25" />
      <path d="M 258 106 q -4 -15, -4 -26" />
      <path d="M 330 95 q 1 -15, 3 -26" />
      <path d="M 402 102 q 6 -14, 10 -24" />
      <path d="M 468 124 q 10 -12, 16 -21" />
      <path d="M 524 158 q 13 -9, 21 -16" />
    </g>
  ), []);

  const OPENING =
    'M 70 222 C 150 120, 258 92, 342 94 C 432 96, 522 140, 572 200 ' +
    'C 520 300, 432 332, 342 332 C 250 332, 148 292, 70 222 Z';

  return (
    <div className="eye-hero-svg">
      <svg
        viewBox="0 0 640 420"
        xmlns="http://www.w3.org/2000/svg"
        className="eye-hero-svg__canvas"
        role="img"
        aria-label="Anatomical illustration of a human eye"
      >
        <defs>
          <radialGradient id="eh-sclera" cx="48%" cy="38%" r="66%">
            <stop offset="0%" stopColor="#FFFFFD" />
            <stop offset="46%" stopColor="#FAF5EC" />
            <stop offset="78%" stopColor="#EADFCC" />
            <stop offset="100%" stopColor="#CFC0A8" />
          </radialGradient>

          {/* Both canthi sit in shadow and carry a little blood. */}
          <radialGradient id="eh-canthus-l" cx="0%" cy="50%" r="42%">
            <stop offset="0%" stopColor="#C98C74" stopOpacity="0.5" />
            <stop offset="60%" stopColor="#B98A72" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#B98A72" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="eh-canthus-r" cx="100%" cy="50%" r="40%">
            <stop offset="0%" stopColor="#BE8B76" stopOpacity="0.4" />
            <stop offset="60%" stopColor="#B98A72" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#B98A72" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="eh-iris" cx="44%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#B3A697" />
            <stop offset="26%" stopColor="#8E8274" />
            <stop offset="60%" stopColor="#5E564C" />
            <stop offset="86%" stopColor="#3C3630" />
            <stop offset="100%" stopColor="#272320" />
          </radialGradient>

          {/* Light entering one side of the stroma and lifting the far edge. */}
          <radialGradient id="eh-iris-bounce" cx="72%" cy="70%" r="46%">
            <stop offset="0%" stopColor="#D8CBB4" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#D8CBB4" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="eh-pupil" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#221D19" />
            <stop offset="62%" stopColor="#15120F" />
            <stop offset="92%" stopColor="#221C17" />
            <stop offset="100%" stopColor="#3A322B" />
          </radialGradient>

          <radialGradient id="eh-retina" cx="50%" cy="50%" r="52%">
            <stop offset="0%" stopColor="#E8875C" />
            <stop offset="42%" stopColor="#CE5C36" />
            <stop offset="78%" stopColor="#9A3418" />
            <stop offset="100%" stopColor="#5A1C0C" />
          </radialGradient>

          <radialGradient id="eh-macula" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7A2410" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#7A2410" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="eh-disc" cx="42%" cy="40%" r="58%">
            <stop offset="0%" stopColor="#FFF0CE" />
            <stop offset="62%" stopColor="#F3CE92" />
            <stop offset="100%" stopColor="#D79A5C" />
          </radialGradient>

          <linearGradient id="eh-lid-shadow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2A1C10" stopOpacity="0.42" />
            <stop offset="38%" stopColor="#2A1C10" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#2A1C10" stopOpacity="0" />
          </linearGradient>

          <linearGradient id="eh-lower-shadow" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#2A1C10" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#2A1C10" stopOpacity="0" />
          </linearGradient>

          {/* The lid that comes down on a blink. */}
          <linearGradient id="eh-lid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#E7DAC6" />
            <stop offset="72%" stopColor="#EFE4D2" />
            <stop offset="100%" stopColor="#D8C6AC" />
          </linearGradient>

          <filter id="eh-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <filter id="eh-soft-sm" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
          <filter id="eh-soft-xs" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.1" />
          </filter>
          <filter id="eh-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Wide enough that the lift under the eye never reads as a shape. */}
          <filter id="eh-halo" x="-60%" y="-90%" width="220%" height="280%">
            <feGaussianBlur stdDeviation="34" />
          </filter>

          <clipPath id="eh-opening">
            <path d={OPENING} />
          </clipPath>
          <clipPath id="eh-pupil-clip">
            <circle cx="0" cy="0" r={Math.max(1, pupilR - 1)} />
          </clipPath>
        </defs>

        <ellipse cx={CX} cy={CY + 4} rx="268" ry="128" fill="#FFFFFF" opacity="0.5" filter="url(#eh-halo)" />
        <ellipse cx={CX} cy={CY + 44} rx="212" ry="72" fill="#1A1008" opacity="0.06" filter="url(#eh-halo)" />

        <g className="eye-hero-svg__globe">
          <g clipPath="url(#eh-opening)">
            <rect x="60" y="80" width="520" height="270" fill="url(#eh-sclera)" />
            <rect x="60" y="80" width="520" height="270" fill="url(#eh-canthus-l)" />
            <rect x="60" y="80" width="520" height="270" fill="url(#eh-canthus-r)" />

            {vesselArt}

            {/* The caruncle in the inner corner. */}
            <ellipse cx="88" cy="226" rx="15" ry="11" fill="#D19A85" opacity="0.5" filter="url(#eh-soft-sm)" />
            <ellipse cx="86" cy="225" rx="7" ry="5" fill="#E0B4A0" opacity="0.45" />

            {/* Gaze: the pointer and the story both move the eye, damped by the
                scroll engine and handed over as custom properties. */}
            <g className="eye-hero-svg__gaze">
              <g className="eye-hero-svg__saccade">
                <g transform={'translate(' + CX + ', ' + CY + ')'}>
                  {/* The globe's own shadow where the iris meets the sclera. */}
                  <circle r={LIMBUS_R + 4} fill="#2A2521" opacity="0.2" filter="url(#eh-soft-sm)" />

                  <circle r={IRIS_R} fill="url(#eh-iris)" />
                  <circle r={IRIS_R} fill="url(#eh-iris-bounce)" />

                  {irisArt}

                  {/* Limbal ring: dense at the edge, fading inward. */}
                  <circle r={IRIS_R - 5} fill="none" stroke="#2B2521" strokeWidth="11" opacity="0.16" />
                  <circle r={LIMBUS_R} fill="none" stroke="#2B2622" strokeWidth="5" opacity="0.5" />
                  <circle r={LIMBUS_R + 3} fill="none" stroke="#3A342E" strokeWidth="3" opacity="0.14" />

                  <g opacity={networkOpacity}>
                    {phcArcs.map((a, i) => (
                      <path
                        key={'a' + i}
                        d={arc(0, 0, LIMBUS_R + 14, a.from, a.to)}
                        fill="none"
                        stroke={a.color}
                        strokeWidth="3"
                        strokeLinecap="round"
                        opacity="0.8"
                        filter="url(#eh-glow)"
                      />
                    ))}
                  </g>

                  {/* The pupil, and the light response it plays on each chapter. */}
                  <g className="eye-hero-svg__light" key={'l' + chapter}>
                    <circle className="eye-hero-svg__pupil" r={pupilR} fill="url(#eh-pupil)" />
                    <circle r={pupilR + 1.6} fill="none" stroke="#1C1815" strokeWidth="3" opacity="0.28" />

                    {/* What the pupil lets through: the fundus, and the signs. */}
                    <g opacity={fundus} clipPath="url(#eh-pupil-clip)">
                      <circle r={pupilR} fill="url(#eh-retina)" />
                      <g transform={'scale(' + (pupilR / 30).toFixed(3) + ')'}>
                        <circle cx="-4" cy="2" r="13" fill="url(#eh-macula)" />

                        <g stroke="#8E2A16" fill="none" strokeLinecap="round" opacity="0.8">
                          <path d="M 11 -3 Q 18 -14, 27 -22" strokeWidth="1.5" />
                          <path d="M 11 -3 Q 19 5, 29 12" strokeWidth="1.3" />
                          <path d="M 11 -3 Q -4 -18, -20 -20" strokeWidth="1.2" />
                          <path d="M 11 -3 Q -6 11, -22 16" strokeWidth="1.1" />
                          <path d="M 18 -11 Q 24 -17, 30 -14" strokeWidth="0.7" />
                          <path d="M 20 7 Q 26 12, 31 9" strokeWidth="0.7" />
                          <path d="M -8 -12 Q -16 -18, -24 -13" strokeWidth="0.6" />
                          <path d="M -10 7 Q -18 13, -25 9" strokeWidth="0.6" />
                        </g>

                        <circle cx="11" cy="-3" r="5.4" fill="url(#eh-disc)" />
                        <circle cx="11" cy="-3" r="5.4" fill="none" stroke="#9A4A20" strokeWidth="0.5" opacity="0.5" />

                        <g opacity={dr.microaneurysms}>{lesions.microaneurysms}</g>
                        <g opacity={dr.haemorrhages}>{lesions.haemorrhages}</g>
                        <g opacity={dr.exudates}>{lesions.exudates}</g>
                        <g opacity={dr.cottonWool}>{lesions.cottonWool}</g>
                        <g opacity={dr.neovascular} stroke="#8E1E0E" fill="none" strokeWidth="0.45">
                          <path d="M 11 -3 q 5 -4, 3 -8 m -3 8 q 7 0, 9 -5 m -9 5 q 5 4, 9 4 m -9 -4 q -1 6, -5 8" />
                          <path d="M 13 -6 q 4 -2, 7 -6 m -7 6 q 6 2, 10 1" />
                        </g>
                      </g>
                    </g>
                  </g>
                </g>
              </g>
            </g>

            {/* The upper lid throws a shadow over the top of the globe. */}
            <rect x="60" y="80" width="520" height="140" fill="url(#eh-lid-shadow)" />
            <rect x="60" y="256" width="520" height="94" fill="url(#eh-lower-shadow)" />

            {/* Cornea: one broad soft highlight, one hard catchlight, one bounce. */}
            <g className="eye-hero-svg__specular">
              <ellipse
                cx={CX - 44}
                cy={CY - 46}
                rx="30"
                ry="19"
                fill="#FFFFFF"
                opacity="0.5"
                filter="url(#eh-soft-sm)"
                transform={'rotate(-24 ' + (CX - 44) + ' ' + (CY - 46) + ')'}
              />
              <circle cx={CX - 32} cy={CY - 54} r="6.5" fill="#FFFFFF" opacity="0.95" />
              <circle cx={CX - 20} cy={CY - 62} r="2.4" fill="#FFFFFF" opacity="0.7" />
              <ellipse cx={CX + 38} cy={CY + 40} rx="16" ry="9" fill="#FFFFFF" opacity="0.22" filter="url(#eh-soft-sm)" />
            </g>

            {/* The blink: the upper lid comes down carrying its own margin and
                lash line, and the lower lid lifts a little to meet it. */}
            <g className="eye-hero-svg__blink-lower">
              <path d="M 44 360 L 596 360 L 596 306 C 520 336, 430 350, 342 350 C 250 350, 138 336, 44 306 Z" fill="url(#eh-lid)" />
            </g>
            <g className="eye-hero-svg__blink">
              <path d="M 40 -280 L 600 -280 L 600 198 C 520 300, 432 332, 342 332 C 250 332, 148 292, 70 222 L 40 204 Z" fill="url(#eh-lid)" />
              {/* The shadow the descending lid casts on the globe. */}
              <path
                d="M 40 204 L 70 222 C 148 292, 250 332, 342 332 C 432 332, 520 300, 600 198"
                fill="none"
                stroke="#2B231C"
                strokeWidth="14"
                strokeLinecap="round"
                opacity="0.1"
                transform="translate(0, -10)"
              />
              {/* Its margin, and the lashes riding on it. */}
              <path
                d="M 40 204 L 70 222 C 148 292, 250 332, 342 332 C 432 332, 520 300, 600 198"
                fill="none"
                stroke="#2B231C"
                strokeWidth="3.4"
                strokeLinecap="round"
                opacity="0.8"
              />
            </g>
          </g>

          {/* Lid lines, drawn over the opening. */}
          <path d="M 70 222 C 150 120, 258 92, 342 94 C 432 96, 522 140, 572 200" fill="none" stroke="#2B231C" strokeWidth="4" strokeLinecap="round" opacity="0.72" />
          <path d="M 70 222 C 150 120, 258 92, 342 94 C 432 96, 522 140, 572 200" fill="none" stroke="#2B231C" strokeWidth="1.4" strokeLinecap="round" opacity="0.3" transform="translate(0, 4)" />
          <path d="M 70 222 C 148 292, 250 332, 342 332 C 432 332, 520 300, 572 200" fill="none" stroke="#2B231C" strokeWidth="2.2" strokeLinecap="round" opacity="0.46" />
          {/* Tear meniscus: the wet line that catches the light. */}
          <path d="M 80 226 C 152 286, 250 322, 342 322 C 430 322, 514 292, 566 204" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
          {/* The crease above, and a few lashes. */}
          <path d="M 104 178 C 180 96, 270 72, 348 74 C 434 76, 510 118, 552 172" fill="none" stroke="#2B231C" strokeWidth="1.2" opacity="0.16" />
          {lashes}
        </g>

        <g opacity={measureOpacity} stroke="#C42B2B" fill="none">
          <line x1="70" y1="368" x2="572" y2="368" strokeWidth="0.7" strokeDasharray="4 5" />
          <line x1="70" y1="362" x2="70" y2="374" strokeWidth="0.9" />
          <line x1="572" y1="362" x2="572" y2="374" strokeWidth="0.9" />
          <text
            x="321"
            y="386"
            textAnchor="middle"
            fill="#C42B2B"
            fontSize="9"
            fontFamily="'JetBrains Mono', monospace"
            letterSpacing="0.14em"
            stroke="none"
          >
            24.2 mm AXIAL LENGTH
          </text>
        </g>
      </svg>
    </div>
  );
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Eases through a set of [progress, value] stops. */
function track(p, stops) {
  for (let i = 1; i < stops.length; i++) {
    const [p1, v1] = stops[i];
    if (p <= p1 || i === stops.length - 1) {
      const [p0, v0] = stops[i - 1];
      return lerp(v0, v1, smoothstep(p0, p1, p));
    }
  }
  return stops[0][1];
}

/** Fades an overlay in as its chapter arrives and out as the next one begins. */
function fade(chapter, chapterProgress, target) {
  if (chapter === target) return smoothstep(0, 0.35, chapterProgress);
  if (chapter === target + 1) return 1 - smoothstep(0, 0.4, chapterProgress);
  return 0;
}

function arc(cx, cy, r, startDeg, endDeg) {
  const p = (deg) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return (cx + r * Math.cos(rad)).toFixed(1) + ' ' + (cy + r * Math.sin(rad)).toFixed(1);
  };
  const large = endDeg - startDeg <= 180 ? 0 : 1;
  return 'M ' + p(startDeg) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p(endDeg);
}

/** Deterministic PRNG, so the iris and vessels are identical on every render. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
