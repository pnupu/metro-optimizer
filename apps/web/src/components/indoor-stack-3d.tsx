import { MercatorCoordinate, type Map as MlMap } from "maplibre-gl";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { IndoorScene3d, Point3d } from "@/lib/indoor-3d";

const LAYER = "indoor-stack";
const STRIDE = 12;
const CORNERS = [0, 1, 2, 2, 1, 3];

type Color = [r: number, g: number, b: number, alpha: number];

function rgba(hex: number, alpha = 1): Color {
  return [(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, alpha];
}

// Vertices stay relative to one Mercator origin to preserve centimetre precision.
function stackMesh(scene: IndoorScene3d, dark: boolean) {
  const originPoint = scene.plates[0]?.ring[0] ?? scene.route[0]?.points[0];
  const origin = MercatorCoordinate.fromLngLat(
    originPoint ? [originPoint[0], originPoint[1]] : [0, 0],
  );
  const data: number[] = [];
  const position = ([lng, lat, height]: Point3d) => {
    const p = MercatorCoordinate.fromLngLat([lng, lat], height);
    return [p.x - origin.x, p.y - origin.y, p.z];
  };
  const triangle = (a: Point3d, b: Point3d, c: Point3d, color: Color) => {
    for (const point of [a, b, c]) data.push(...position(point), 0, 0, 0, 0, 0, ...color);
  };
  const quad = (a: Point3d, b: Point3d, c: Point3d, d: Point3d, color: Color) => {
    triangle(a, b, c, color);
    triangle(a, c, d, color);
  };
  const stroke = (a: Point3d, b: Point3d, radius: number, color: Color) => {
    const start = position(a);
    const end = position(b);
    for (const corner of CORNERS) data.push(...start, ...end, corner, radius, ...color);
  };
  const line = (points: Point3d[], radius: number, color: Color) => {
    if (points.length === 1) stroke(points[0]!, points[0]!, radius, color);
    for (let i = 1; i < points.length; i++) stroke(points[i - 1]!, points[i]!, radius, color);
  };
  const drop = ([x, y, z]: Point3d): Point3d => [x, y, z - 0.55];
  const routeColor = rgba(dark ? 0xff874c : 0xf76022);
  const currentColor = rgba(0xffcf54);
  const casing = rgba(dark ? 0x27160f : 0x5d291b);
  const rampEdge = rgba(dark ? 0xffa177 : 0xb84318, 0.86);
  const offset = ([lng, lat, height]: Point3d, x: number, y: number): Point3d => [
    lng + x / (111_320 * Math.cos((lat * Math.PI) / 180)),
    lat + y / 111_320,
    height,
  ];

  // Draw the translucent stack in floor order. The path is drawn last so an upper
  // plate cannot mask where the user walks on a lower floor.
  const { route, plates, context } = scene;
  for (const [index, { ring, active }] of plates.entries()) {
    if (ring.length < 3) continue;
    const tinted = index % 2 === 0;
    const fill = dark ? (tinted ? 0x39769e : 0x4f61a6) : tinted ? 0x72b5d8 : 0x9caadb;
    const top = rgba(fill, active ? 0.68 : 0.4);
    const side = rgba(dark ? 0x6296b8 : 0x356483, active ? 0.84 : 0.53);
    const edge = rgba(dark ? 0xa9ddf7 : 0x245878, active ? 0.95 : 0.72);
    for (let i = 2; i < ring.length; i++) triangle(ring[0]!, ring[i - 1]!, ring[i]!, top);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      quad(a, b, drop(b), drop(a), side);
      stroke(a, b, active ? 1.35 : 0.9, edge);
    }
  }
  const detail = rgba(dark ? 0xb5d6e7 : 0x335f75, 0.24);
  for (const points of context) line(points, 0.7, detail);

  for (const { points, shaft, ramp } of route) {
    if (ramp) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
        const dy = b[1] - a[1];
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        const x = (-dy / length) * 1.65;
        const y = (dx / length) * 1.65;
        const corners = [
          offset(a, x, y),
          offset(b, x, y),
          offset(b, -x, -y),
          offset(a, -x, -y),
        ] as const;
        quad(...corners, rgba(dark ? 0xd36837 : 0xd95c2b, 0.35));
        stroke(corners[0], corners[1], 0.85, rampEdge);
        stroke(corners[2], corners[3], 0.85, rampEdge);
      }
    }
    if (shaft) {
      const [a, b] = shaft;
      const corners = (p: Point3d) => [
        offset(p, -2, -2),
        offset(p, -2, 2),
        offset(p, 2, 2),
        offset(p, 2, -2),
      ];
      const from = corners(a);
      const to = corners(b);
      for (let i = 0; i < from.length; i++) {
        const next = (i + 1) % from.length;
        stroke(from[i]!, to[i]!, 0.85, rampEdge);
        stroke(from[i]!, from[next]!, 0.95, rampEdge);
        stroke(to[i]!, to[next]!, 0.95, rampEdge);
      }
    }
  }
  const drawRoute = (
    { points, shaft }: IndoorScene3d["route"][number],
    radius: number,
    color: Color,
  ) => {
    if (!shaft) {
      line(points, radius, color);
      return;
    }
    const [a, b] = shaft;
    stroke(points[0]!, a, radius, color);
    stroke(b, points.at(-1)!, radius, color);
    // The thinner stroke between the landings keeps the lift enclosure readable.
    stroke(a, b, radius * 0.42, color);
  };
  for (const section of route) drawRoute(section, section.active ? 5.5 : 4.25, casing);
  for (const section of route) {
    if (!section.active) drawRoute(section, 2.8, routeColor);
  }
  for (const section of route) {
    if (section.active) drawRoute(section, 3.85, currentColor);
  }
  return { origin, data: new Float32Array(data) };
}

// A segment is a screen-space capsule. Its width stays legible as the camera
// tilts and zooms, and the rounded ends join bends without gaps.
const vertexSource = `#version 300 es
layout(location = 0) in vec3 a_start;
layout(location = 1) in vec3 a_end;
layout(location = 2) in vec2 a_stroke;
layout(location = 3) in vec4 a_color;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
flat out vec4 v_color;
flat out float v_radius;
flat out float v_length;
out vec2 v_pixel;
void main() {
  vec4 a = u_matrix * vec4(a_start, 1.0);
  v_color = a_color;
  v_radius = a_stroke.y;
  v_length = 0.0;
  v_pixel = vec2(0.0);
  if (v_radius == 0.0) {
    gl_Position = a;
    return;
  }
  vec4 b = u_matrix * vec4(a_end, 1.0);
  if (a.w <= 0.0 || b.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 pa = a.xy / a.w;
  vec2 pb = b.xy / b.w;
  vec2 delta = (pb - pa) * u_viewport;
  v_length = length(delta);
  vec2 axis = v_length < 0.01 ? vec2(1.0, 0.0) : delta / v_length;
  vec2 normal = vec2(-axis.y, axis.x);
  float side = mod(a_stroke.x, 2.0) * 2.0 - 1.0;
  bool atEnd = a_stroke.x >= 2.0;
  float margin = v_radius + 1.0;
  float cap = atEnd ? margin : -margin;
  v_pixel = vec2((atEnd ? v_length : 0.0) + cap, margin * side);
  vec2 p = (atEnd ? pb : pa) + (axis * cap + normal * margin * side) / u_viewport;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;
flat in vec4 v_color;
flat in float v_radius;
flat in float v_length;
in vec2 v_pixel;
out vec4 outColor;
void main() {
  float coverage = 1.0;
  if (v_radius > 0.0) {
    vec2 d = v_pixel - vec2(clamp(v_pixel.x, 0.0, v_length), 0.0);
    coverage = 1.0 - smoothstep(v_radius - 0.6, v_radius + 0.6, length(d));
  }
  float alpha = v_color.a * coverage;
  outColor = vec4(v_color.rgb * alpha, alpha);
}`;

function makeProgram(gl: WebGL2RenderingContext) {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  const error = gl.getProgramParameter(program, gl.LINK_STATUS)
    ? undefined
    : [
        gl.getProgramInfoLog(program),
        gl.getShaderInfoLog(vertex),
        gl.getShaderInfoLog(fragment),
      ].join("\n");
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (error) {
    gl.deleteProgram(program);
    throw new Error(error);
  }
  return program;
}

export function IndoorStack3d({
  mapRef,
  ready,
  scene,
  dark,
}: {
  mapRef: RefObject<MlMap | null>;
  ready: number;
  scene: IndoorScene3d;
  dark: boolean;
}) {
  const mesh = useMemo(() => stackMesh(scene, dark), [scene, dark]);
  const latest = useRef(mesh);
  useLayoutEffect(() => {
    latest.current = mesh;
    mapRef.current?.triggerRepaint();
  }, [mapRef, mesh]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let program: WebGLProgram;
    let buffer: WebGLBuffer;
    let vao: WebGLVertexArrayObject;
    let matrix: WebGLUniformLocation | null;
    let viewport: WebGLUniformLocation | null;
    let uploaded: typeof mesh | undefined;
    const translated = new Float32Array(16);
    map.addLayer({
      id: LAYER,
      type: "custom",
      renderingMode: "2d",
      onAdd(_map, gl: WebGL2RenderingContext) {
        program = makeProgram(gl);
        matrix = gl.getUniformLocation(program, "u_matrix");
        viewport = gl.getUniformLocation(program, "u_viewport");
        buffer = gl.createBuffer()!;
        vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const sizes = [3, 3, 2, 4];
        let offset = 0;
        for (const [i, size] of sizes.entries()) {
          gl.enableVertexAttribArray(i);
          gl.vertexAttribPointer(i, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
          offset += size;
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      },
      onRemove(_map, gl: WebGL2RenderingContext) {
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
      },
      render(gl, { defaultProjectionData: { mainMatrix: m } }) {
        const current = latest.current;
        if (map.getZoom() < 14 || !current.data.length) return;
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        if (uploaded !== current) {
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, current.data, gl.STATIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          uploaded = current;
        }
        translated.set(m);
        for (let i = 0; i < 4; i++) {
          translated[i + 12] = m[i]! * current.origin.x + m[i + 4]! * current.origin.y + m[i + 12]!;
        }
        gl.uniformMatrix4fv(matrix, false, translated);
        gl.uniform2f(viewport, map.getCanvas().clientWidth / 2, map.getCanvas().clientHeight / 2);
        gl.drawArrays(gl.TRIANGLES, 0, current.data.length / STRIDE);
        gl.bindVertexArray(null);
      },
    });
    return () => {
      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    };
  }, [mapRef, ready]);

  return null;
}
