/**
 * Material layers, stacked on the GPU (ruling of 2026-09-18).
 *
 * Every terrain vertex carries four atlas UVs, one per material layer: `uv`
 * for the first, and `uvLayer1`–`uvLayer3` for the rest, which the mesher
 * packs into `MeshBuffers.stackUvs`. The fragment shader samples the atlas
 * four times and lays each layer over the ones below it, alpha and all, so a
 * layer's transparent edge tiles show what is under them and a half-clear
 * layer (glass, a puddle) tints rather than covers. Nothing is baked: the
 * atlas holds only authored tiles, and the stack is decided per pixel.
 *
 * A layer can be hidden from the view without touching the document: the
 * `stackShown` uniform scales each layer's alpha to nothing. The material
 * keeps its `alphaTest`, so a pixel no shown layer covers is not drawn.
 */

import * as THREE from 'three'

import type { MeshBuffers } from '@papercut/geometry'

/** How many material layers a face stacks. */
const STACK = 4

/** Set the stacked UVs a terrain chunk carries on its geometry, when it carries any. */
export function setStackUvs(geometry: THREE.BufferGeometry, buffers: MeshBuffers): void {
  if (!buffers.stackUvs) return
  const interleaved = new THREE.InterleavedBuffer(buffers.stackUvs, 2 * (STACK - 1))
  for (let layer = 1; layer < STACK; layer++) geometry.setAttribute(`uvLayer${layer}`, new THREE.InterleavedBufferAttribute(interleaved, 2, 2 * (layer - 1)))
}

const VERTEX_HEAD = `attribute vec2 uvLayer1;
attribute vec2 uvLayer2;
attribute vec2 uvLayer3;
varying vec2 vUvLayer1;
varying vec2 vUvLayer2;
varying vec2 vUvLayer3;
`

const VERTEX_BODY = `#include <uv_vertex>
#ifdef USE_MAP
	vUvLayer1 = ( mapTransform * vec3( uvLayer1, 1 ) ).xy;
	vUvLayer2 = ( mapTransform * vec3( uvLayer2, 1 ) ).xy;
	vUvLayer3 = ( mapTransform * vec3( uvLayer3, 1 ) ).xy;
#endif`

const FRAGMENT_HEAD = `uniform vec4 stackShown;
varying vec2 vUvLayer1;
varying vec2 vUvLayer2;
varying vec2 vUvLayer3;
// One layer over what is below it, non-premultiplied in and out.
vec4 stackOver( vec4 below, vec4 above, float shown ) {
	float a = above.a * shown;
	float outA = a + below.a * ( 1.0 - a );
	vec3 rgb = outA > 0.0 ? ( above.rgb * a + below.rgb * below.a * ( 1.0 - a ) ) / outA : vec3( 0.0 );
	return vec4( rgb, outA );
}
`

const FRAGMENT_BODY = `#ifdef USE_MAP
	vec4 stacked = stackOver( vec4( 0.0 ), texture2D( map, vMapUv ), stackShown.x );
	stacked = stackOver( stacked, texture2D( map, vUvLayer1 ), stackShown.y );
	stacked = stackOver( stacked, texture2D( map, vUvLayer2 ), stackShown.z );
	stacked = stackOver( stacked, texture2D( map, vUvLayer3 ), stackShown.w );
	diffuseColor *= stacked;
#endif`

/**
 * Make `material` draw the four material layers stacked. It keeps whatever
 * shader patch it already had (the section cut's) and adds this one after.
 * Returns the uniform that says which layers are shown, one 0-or-1 per layer.
 */
export function stackLayers(material: THREE.MeshStandardMaterial): { value: THREE.Vector4 } {
  const shown = { value: new THREE.Vector4(1, 1, 1, 1) }
  const before = material.onBeforeCompile.bind(material)
  const key = material.customProgramCacheKey.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer)
    shader.uniforms.stackShown = shown
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace('#include <uv_vertex>', VERTEX_BODY)
    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace('#include <map_fragment>', FRAGMENT_BODY)
  }
  material.customProgramCacheKey = () => `${key()}+stacked`
  return shown
}
