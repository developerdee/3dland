import * as THREE from 'three';

/**
 * Low-poly prop geometry, built in code rather than loaded.
 *
 * Nothing here needs to survive close inspection: at the densities we scatter,
 * most of these are a few pixels tall. Building them procedurally avoids any
 * asset pipeline, keeps the download at zero bytes, and means a variant is a
 * parameter change rather than another file.
 *
 * Triangle counts are kept deliberately low — a few thousand instances
 * multiplies everything.
 */

/** A conifer: tapered trunk with two or three stacked cones. */
function conifer(tiers: number, spread: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const trunkHeight = 1.1;
  const trunk = new THREE.CylinderGeometry(0.07, 0.11, trunkHeight, 5);
  trunk.translate(0, trunkHeight / 2, 0);
  parts.push(trunk);

  // Cones overlap deliberately, so the silhouette reads as one canopy rather
  // than separate floating discs.
  let y = trunkHeight * 0.72;
  let radius = 0.62 * spread;
  let height = 1.5;

  for (let i = 0; i < tiers; i++) {
    const cone = new THREE.ConeGeometry(radius, height, 7);
    cone.translate(0, y + height / 2, 0);
    parts.push(cone);
    y += height * 0.52;
    radius *= 0.72;
    height *= 0.82;
  }

  return mergeAndColor(parts, [
    { count: 1, color: 0x4a3828 }, // trunk
    { count: tiers, color: 0x2f4a2a }, // needles
  ]);
}

/** A broadleaf: short trunk and an irregular lumpy crown. */
function broadleaf(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const trunkHeight = 1.3;
  const trunk = new THREE.CylinderGeometry(0.08, 0.13, trunkHeight, 5);
  trunk.translate(0, trunkHeight / 2, 0);
  parts.push(trunk);

  // Three offset spheres make a crown that is not obviously a ball. Low
  // segment counts keep it faceted, which suits the rest of the look.
  const blobs: Array<[number, number, number, number]> = [
    [0, trunkHeight + 0.55, 0, 0.78],
    [0.34, trunkHeight + 0.3, 0.18, 0.52],
    [-0.26, trunkHeight + 0.42, -0.24, 0.46],
  ];

  for (const [x, y, z, r] of blobs) {
    const blob = new THREE.SphereGeometry(r, 6, 5);
    blob.translate(x, y, z);
    parts.push(blob);
  }

  return mergeAndColor(parts, [
    { count: 1, color: 0x4a3828 },
    { count: blobs.length, color: 0x3d5e2c },
  ]);
}

/** A boulder: a sphere squashed and jittered into something irregular. */
function boulder(seed: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(0.5, 7, 5);
  const position = geometry.attributes.position as THREE.BufferAttribute;

  // Deterministic jitter, so each variant is a fixed shape rather than a new
  // one on every page load.
  let state = seed * 2654435761;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i);
    vertex.multiplyScalar(0.78 + next() * 0.44);
    vertex.y *= 0.66; // squash: boulders sit, they do not float
    position.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }

  // Sink slightly, so a boulder looks bedded into the ground rather than
  // balanced on it.
  geometry.translate(0, 0.17, 0);
  geometry.computeVertexNormals();

  return applyColor(geometry, 0x6d6762);
}

/** A shrub: a couple of squat blobs, no trunk. */
function shrub(variant: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const count = variant === 0 ? 2 : 3;

  for (let i = 0; i < count; i++) {
    const r = 0.3 + i * 0.07;
    const blob = new THREE.SphereGeometry(r, 5, 4);
    const angle = (i / count) * Math.PI * 2;
    blob.scale(1, 0.62, 1);
    blob.translate(Math.cos(angle) * 0.17, r * 0.56, Math.sin(angle) * 0.17);
    parts.push(blob);
  }

  return mergeAndColor(parts, [{ count, color: 0x445c30 }]);
}

export interface PropSet {
  trees: THREE.BufferGeometry[];
  rocks: THREE.BufferGeometry[];
  shrubs: THREE.BufferGeometry[];
}

/** Builds every prop variant once, for instancing to reference. */
export function buildProps(): PropSet {
  return {
    trees: [conifer(3, 1), conifer(2, 1.18), broadleaf()],
    rocks: [boulder(1), boulder(2), boulder(3)],
    shrubs: [shrub(0), shrub(1)],
  };
}

export function disposeProps(props: PropSet): void {
  for (const list of [props.trees, props.rocks, props.shrubs]) {
    for (const geometry of list) geometry.dispose();
  }
}

/**
 * Concatenates geometries into one buffer and bakes a colour per group.
 *
 * Instanced rendering needs a single geometry per mesh, and separate materials
 * would mean separate draw calls per part — defeating the point. Baking colour
 * into vertex attributes keeps a whole tree to one instanced draw call.
 */
function mergeAndColor(
  parts: THREE.BufferGeometry[],
  groups: Array<{ count: number; color: number }>,
): THREE.BufferGeometry {
  // Expand group definitions to one colour per part.
  const colors: number[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) colors.push(group.color);
  }

  let totalVertices = 0;
  let totalIndices = 0;
  for (const part of parts) {
    totalVertices += (part.attributes.position as THREE.BufferAttribute).count;
    totalIndices += part.index ? part.index.count : 0;
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colorData = new Float32Array(totalVertices * 3);
  const indices = new Uint16Array(totalIndices);

  const tint = new THREE.Color();
  let vertexOffset = 0;
  let indexOffset = 0;

  parts.forEach((part, partIndex) => {
    const position = part.attributes.position as THREE.BufferAttribute;
    const normal = part.attributes.normal as THREE.BufferAttribute;
    const count = position.count;

    positions.set(position.array as Float32Array, vertexOffset * 3);
    if (normal) normals.set(normal.array as Float32Array, vertexOffset * 3);

    tint.set(colors[partIndex] ?? 0xffffff);
    for (let i = 0; i < count; i++) {
      colorData[(vertexOffset + i) * 3] = tint.r;
      colorData[(vertexOffset + i) * 3 + 1] = tint.g;
      colorData[(vertexOffset + i) * 3 + 2] = tint.b;
    }

    // Indices are local to each part, so they must be rebased as parts are
    // appended into the shared buffer.
    if (part.index) {
      const source = part.index.array;
      for (let i = 0; i < source.length; i++) {
        indices[indexOffset + i] = (source[i] as number) + vertexOffset;
      }
      indexOffset += source.length;
    }

    vertexOffset += count;
    part.dispose();
  });

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colorData, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();

  return merged;
}

/** Bakes a single colour across an existing geometry. */
function applyColor(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const data = new Float32Array(position.count * 3);
  const tint = new THREE.Color(color);
  for (let i = 0; i < position.count; i++) {
    data[i * 3] = tint.r;
    data[i * 3 + 1] = tint.g;
    data[i * 3 + 2] = tint.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return geometry;
}
