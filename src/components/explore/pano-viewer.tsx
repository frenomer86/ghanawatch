"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A small WebGL viewer for 360° equirectangular photos: drag to look around,
 * scroll or use the +/- keys to zoom, arrow keys to turn. One full-screen
 * triangle pair; the fragment shader turns each pixel's view ray into a
 * longitude/latitude lookup in the panorama, so no 3D library is needed.
 */
const VERT = `attribute vec2 p;
varying vec2 v;
void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `precision highp float;
varying vec2 v;
uniform sampler2D tex;
uniform float yaw;
uniform float pitch;
uniform float fov;
uniform float aspect;
const float PI = 3.14159265358979;
void main() {
  float f = tan(fov * 0.5);
  vec3 d = normalize(vec3(v.x * f * aspect, v.y * f, 1.0));
  float cp = cos(pitch);
  float sp = sin(pitch);
  d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(yaw);
  float sy = sin(yaw);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  float lon = atan(d.x, d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  gl_FragColor = texture2D(tex, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
}`;

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
  return s;
}

export function PanoCanvas({ src, label, loadingText, errorText }: { src: string; label: string; loadingText: string; errorText: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false });
    if (!gl) {
      setState("error");
      return;
    }
    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("link failed");
    } catch {
      setState("error");
      return;
    }
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {
      yaw: gl.getUniformLocation(program, "yaw"),
      pitch: gl.getUniformLocation(program, "pitch"),
      fov: gl.getUniformLocation(program, "fov"),
      aspect: gl.getUniformLocation(program, "aspect"),
    };
    const view = { yaw: 0, pitch: 0, fov: 80 * DEG };
    let raf = 0;
    let hasTexture = false;

    const draw = () => {
      raf = 0;
      if (!hasTexture) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform1f(u.yaw, view.yaw);
      gl.uniform1f(u.pitch, view.pitch);
      gl.uniform1f(u.fov, view.fov);
      gl.uniform1f(u.aspect, w / Math.max(1, h));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const request = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      let source: TexImageSource = img;
      if (img.naturalWidth > max) {
        const c = document.createElement("canvas");
        c.width = max;
        c.height = Math.round((img.naturalHeight * max) / img.naturalWidth);
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        source = c;
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      hasTexture = true;
      setState("ready");
      request();
    };
    img.onerror = () => setState("error");
    img.src = src;

    let drag: { x: number; y: number; id: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const k = view.fov / Math.max(1, canvas.clientHeight);
      view.yaw -= (e.clientX - drag.x) * k;
      view.pitch = clamp(view.pitch + (e.clientY - drag.y) * k, -85 * DEG, 85 * DEG);
      drag = { ...drag, x: e.clientX, y: e.clientY };
      request();
    };
    const up = () => (drag = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      view.fov = clamp(view.fov * Math.exp(e.deltaY * 0.001), 30 * DEG, 100 * DEG);
      request();
    };
    const key = (e: KeyboardEvent) => {
      const step = 5 * DEG;
      if (e.key === "ArrowLeft") view.yaw -= step;
      else if (e.key === "ArrowRight") view.yaw += step;
      else if (e.key === "ArrowUp") view.pitch = clamp(view.pitch + step, -85 * DEG, 85 * DEG);
      else if (e.key === "ArrowDown") view.pitch = clamp(view.pitch - step, -85 * DEG, 85 * DEG);
      else if (e.key === "+" || e.key === "=") view.fov = clamp(view.fov * 0.9, 30 * DEG, 100 * DEG);
      else if (e.key === "-") view.fov = clamp(view.fov / 0.9, 30 * DEG, 100 * DEG);
      else return;
      e.preventDefault();
      request();
    };
    const ro = new ResizeObserver(request);
    ro.observe(canvas);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      img.onload = null;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [src]);

  return (
    <div className="relative h-full w-full bg-black">
      <canvas ref={canvasRef} tabIndex={0} role="img" aria-label={label} className="h-full w-full cursor-grab touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing" />
      {state !== "ready" && (
        <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/80">{state === "loading" ? loadingText : errorText}</p>
      )}
    </div>
  );
}
