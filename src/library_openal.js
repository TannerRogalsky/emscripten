//"use strict";

var LibraryOpenAL = {
	// ************************************************************************
	// ** INTERNALS 
	// ************************************************************************

	$AL__deps: ["$Browser"],
	$AL: {
		// ------------------------------------------------------
		// -- Constants 
		// ------------------------------------------------------

		QUEUE_INTERVAL: 25,
		QUEUE_LOOKAHEAD: 100.0 / 1000.0,

		// ------------------------------------------------------
		// -- ALC Fields
		// ------------------------------------------------------

		_alcErr: 0,
		get alcErr() {
			return this._alcErr;
		},
		set alcErr(val) {
			// Errors should not be overwritten by later errors until they are cleared by a query.
			if (this._alcErr === 0 /* ALC_NO_ERROR */) {
				this._alcErr = val;
			}
		},

		alcStringCache: {},

		// ------------------------------------------------------
		// -- AL Fields
		// ------------------------------------------------------

		stringCache: {},
		contexts: [],
		currentCtx: null,
		buffers: [],

		// ------------------------------------------------------
		// -- Mixing Logic
		// ------------------------------------------------------

		scheduleContextAudio: function(ctx) {
			// If we are animating using the requestAnimationFrame method, then the main loop does not run when in the background.
			// To give a perfect glitch-free audio stop when switching from foreground to background, we need to avoid updating
			// audio altogether when in the background, so detect that case and kill audio buffer streaming if so.
			if (Browser.mainLoop.timingMode === 1/*EM_TIMING_RAF*/ && document["visibilityState"] != "visible") {
				return;
			}

			for (var i in ctx.sources) {
				AL.scheduleSourceAudio(ctx.sources[i]);
			}
		},

		scheduleSourceAudio: function(src, lookahead) {
			// See comment on scheduleContextAudio above.
			if (Browser.mainLoop.timingMode === 1/*EM_TIMING_RAF*/ && document["visibilityState"] != "visible") {
				return;
			}
			if (src.state !== 0x1012 /* AL_PLAYING */) {
				return;
			}

			AL.updateSourceTime(src);

			var startTime = src.bufStartTime;
			var startOffset = src.bufOffset;
			var bufCursor = src.bufsProcessed;

			for (var i = 0; i < src.audioQueue.length; i++) {
				var audioSrc = src.audioQueue[i];
				startTime = audioSrc._startTime + audioSrc._duration;
				startOffset = 0.0;
				bufCursor++;
			}

			if (!lookahead) {
				lookahead = AL.QUEUE_LOOKAHEAD;
			}
			var lookaheadTime = src.context.audioCtx.currentTime + lookahead;
			while (startTime < lookaheadTime) {
				if (bufCursor >= src.bufQueue.length) {
					if (src.loop) {
						bufCursor %= src.bufQueue.length;
					} else {
						break;
					}
				}

				var buf = src.bufQueue[bufCursor % src.bufQueue.length];
				var duration = (buf.audioBuf.duration - startOffset) / src.playbackRate;

				var audioSrc = src.context.audioCtx.createBufferSource();
				audioSrc._startOffset = startOffset;
				audioSrc._duration = duration;
				audioSrc.buffer = buf.audioBuf;
				audioSrc.connect(src.gain);
				audioSrc.playbackRate.value = src.playbackRate;

				if (typeof(audioSrc.start) !== "undefined") {
					startTime = Math.max(startTime, src.context.audioCtx.currentTime);
					audioSrc.start(startTime, startOffset);
				} else if (typeof(audioSrc.noteOn) !== "undefined") {
					startTime = Math.max(startTime, src.context.audioCtx.currentTime);
					audioSrc.noteOn(startTime);
#if OPENAL_DEBUG
					if (offset > 0.0) {
						Runtime.warnOnce("The current browser does not support AudioBufferSourceNode.start(when, offset); method, so cannot play back audio with an offset "+startOffset+" secs! Audio glitches will occur!");
					}
#endif
				}
#if OPENAL_DEBUG
				else {
					Runtime.warnOnce("Unable to start AudioBufferSourceNode playback! Not supported by the browser?");
				}

				console.log("scheduleSourceAudio() queuing buffer " + buf.id + " for source " + src.id + " at " + startTime + " (offset by " + startOffset + ")");
#endif
				audioSrc._startTime = startTime;
				src.audioQueue.push(audioSrc);

				startTime += duration;
				startOffset = 0.0;
				bufCursor++;
			}
		},

		// Advance the state of a source forward to the current time
		updateSourceTime: function(src) {
			if (src.state !== 0x1012 /* AL_PLAYING */) {
				return;
			}

			var currentTime = src.context.audioCtx.currentTime;
			if (!isFinite(src.bufStartTime)) {
				src.bufStartTime = currentTime - src.bufOffset / src.playbackRate;
				src.bufOffset = 0.0;
			}

			var nextStartTime = 0.0;
			while (src.audioQueue.length) {
				var audioSrc = src.audioQueue[0];
				nextStartTime = audioSrc._startTime + audioSrc._duration; // n.b. audioSrc._duration already factors in playbackRate, so no divide by src.playbackRate on it.

				if (currentTime < nextStartTime) {
					break;
				}

				src.audioQueue.shift();
				src.bufStartTime = nextStartTime;
				src.bufOffset = 0.0;
				src.bufsProcessed++;
			}

			var audioSrc = src.audioQueue[0];
			if (audioSrc) {
				src.bufOffset = (currentTime - audioSrc._startTime) * src.playbackRate;
			} else {
				while (true) {
					if (src.bufsProcessed >= src.bufQueue.length) {
						if (src.loop) {
							src.bufsProcessed %= src.bufQueue.length;
						} else {
							AL.setSourceState(src, 0x1014 /* AL_STOPPED */);
							break;
						}
					}
					var buf = src.bufQueue[src.bufsProcessed];
					nextStartTime = src.bufStartTime + buf.audioBuf.duration / src.playbackRate;

					if (currentTime < nextStartTime) {
						src.bufOffset = (currentTime - src.bufStartTime) * src.playbackRate;
						break;
					}

					src.bufStartTime = nextStartTime;
					src.bufOffset = 0.0;
					src.bufsProcessed++;
				}
			}
		},

		cancelPendingSourceAudio: function(src) {
			AL.updateSourceTime(src);

			for (var i = 1; i < src.audioQueue.length; i++) {
				var audioSrc = src.audioQueue[i];
				audioSrc.stop();
			}

			if (src.audioQueue.length) {
				src.audioQueue.length = 1;
			}
		},

		stopSourceAudio: function(src) {
			for (var i = 0; i < src.audioQueue.length; i++) {
				src.audioQueue[i].stop();
			}
			src.audioQueue.length = 0;
		},

		setSourceState: function(src, state) {
			if (state === 0x1012 /* AL_PLAYING */) {
				if (src.state === 0x1012 /* AL_PLAYING */ || src.state == 0x1014 /* AL_STOPPED */) {
					src.bufsProcessed = 0;
					src.bufOffset = 0.0;
#if OPENAL_DEBUG
					console.log("setSourceState() resetting and playing source " + src.id);
#endif
				} else {
#if OPENAL_DEBUG
					console.log("setSourceState() playing source " + src.id + " at " + src.bufOffset);
#endif
				}

				AL.stopSourceAudio(src);

				src.state = 0x1012 /* AL_PLAYING */;
				src.bufStartTime = Number.NEGATIVE_INFINITY;
				AL.scheduleSourceAudio(src);
			} else if (state === 0x1013 /* AL_PAUSED */) {
				if (src.state === 0x1012 /* AL_PLAYING */) {
					// Store off the current offset to restore with on resume.
					AL.updateSourceTime(src);
					AL.stopSourceAudio(src);

					src.state = 0x1013 /* AL_PAUSED */;
#if OPENAL_DEBUG
					console.log("setSourceState() pausing source " + src.id + " at " + src.bufOffset);
#endif
				}
			} else if (state === 0x1014 /* AL_STOPPED */) {
				if (src.state !== 0x1011 /* AL_INITIAL */) {
					src.state = 0x1014 /* AL_STOPPED */;
					src.bufsProcessed = src.bufQueue.length;
					src.bufStartTime = Number.NEGATIVE_INFINITY;
					src.bufOffset = 0.0;
					AL.stopSourceAudio(src);
#if OPENAL_DEBUG
					console.log("setSourceState() stopping source " + src.id);
#endif
				}
			} else if (state === 0x1011 /* AL_INITIAL */) {
				if (src.state !== 0x1011 /* AL_INITIAL */) {
					src.state = 0x1011 /* AL_INITIAL */;
					src.bufsProcessed = 0;
					src.bufStartTime = Number.NEGATIVE_INFINITY;
					src.bufOffset = 0.0;
					AL.stopSourceAudio(src);
#if OPENAL_DEBUG
					console.log("setSourceState() initializing source " + src.id);
#endif
				}
			}
		},

		initSourcePanner: function(src) {
			if (src.type === 0x1030 /* AL_UNDETERMINED */) {
				return;
			}

			if (src.bufQueue[0].audioBuf.numberOfChannels == 1) {
				if (src.panner) {
					return;
				}
				var panner = src.context.audioCtx.createPanner();

				panner.panningModel = "equalpower";
				panner.distanceModel = "linear";
				panner.refDistance = src.refDistance;
				panner.maxDistance = src.maxDistance;
				panner.rolloffFactor = src.rolloffFactor;

				AL.updateSourceSpace(src);

				panner.connect(src.context.gain);
				src.gain.disconnect();
				src.gain.connect(panner);
				src.panner = panner;
			} else {
				if (!src.panner) {
					return;
				}

				src.panner.disconnect();
				src.gain.disconnect();
				src.gain.connect(src.context.gain);
				src.panner = null;
			}
		},

		updateListenerSpace: function(ctx) {
			var listener = ctx.audioCtx.listener;
			if (listener.positionX) {
				listener.positionX.value = listener._position[0];
				listener.positionY.value = listener._position[1];
				listener.positionZ.value = listener._position[2];
			} else {
#if OPENAL_DEBUG
				Runtime.warnOnce("Listener position attributes are not present, falling back to setPosition()");
#endif
				listener.setPosition(listener._position[0], listener._position[1], listener._position[2]);
			}
			if (listener.forwardX) {
				listener.forwardX.value = listener._direction[0];
				listener.forwardY.value = listener._direction[1];
				listener.forwardZ.value = listener._direction[2];
				listener.upX.value = listener._up[0];
				listener.upY.value = listener._up[1];
				listener.upZ.value = listener._up[2];
			} else {
#if OPENAL_DEBUG
				Runtime.warnOnce("Listener orientation attributes are not present, falling back to setOrientation()");
#endif
				listener.setOrientation(
					listener._direction[0], listener._direction[1], listener._direction[2],
					listener._up[0], listener._up[1], listener._up[2]);
			}

			// Update sources that are relative to the listener
			for (var i in ctx.sources) {
				if (ctx.sources[i].relative) {
					AL.updateSourceSpace(ctx.sources[i]);
				}
			}
		},

		updateSourceSpace: function(src) {
			if (!src.panner) {
				return;
			}
			var panner = src.panner;

			var posX = src.position[0];
			var posY = src.position[1];
			var posZ = src.position[2];
			var dirX = src.direction[0];
			var dirY = src.direction[1];
			var dirZ = src.direction[2];

			// WebAudio expects world space coordinates, so if the source is listener-relative
			// we must transform the coordinates from listener space into world space.
			if (src.relative) {
				var listener = src.context.audioCtx.listener;
				// Negate the listener direction since forward is -Z.
				var lBackX = -listener._direction[0];
				var lBackY = -listener._direction[1];
				var lBackZ = -listener._direction[2];
				var lUpX = listener._up[0];
				var lUpY = listener._up[1];
				var lUpZ = listener._up[2];

				// Normalize the Back vector
				var invMag = 1.0 / Math.sqrt(lBackX * lBackX + lBackY * lBackY + lBackZ * lBackZ);
				lBackX *= invMag;
				lBackY *= invMag;
				lBackZ *= invMag;

				// ...and the Up vector
				var invMag = 1.0 / Math.sqrt(lUpX * lUpX + lUpY * lUpY + lUpZ * lUpZ);
				lUpX *= invMag;
				lUpY *= invMag;
				lUpZ *= invMag;

				// Calculate the Right vector as the cross product of the Up and Back vectors
				var lRightX = (lUpY * lBackZ - lUpZ * lBackY);
				var lRightY = (lUpZ * lBackX - lUpX * lBackZ);
				var lRightZ = (lUpX * lBackY - lUpY * lBackX);

				var oldX = dirX;
				var oldY = dirY;
				var oldZ = dirZ;

				// Use our 3 vectors to apply a change-of-basis matrix to the source direction
				dirX = oldX * lRightX + oldY * lUpX + oldZ * lBackX;
				dirY = oldX * lRightY + oldY * lUpY + oldZ * lBackY;
				dirZ = oldX * lRightZ + oldY * lUpZ + oldZ * lBackZ;

				var oldX = posX;
				var oldY = posY;
				var oldZ = posZ;

				// ...and to the source position
				posX = oldX * lRightX + oldY * lUpX + oldZ * lBackX;
				posY = oldX * lRightY + oldY * lUpY + oldZ * lBackY;
				posZ = oldX * lRightZ + oldY * lUpZ + oldZ * lBackZ;

				// The change-of-basis corrects the orientation, but the origin is still the listener.
				// Translate the source position by the listener position to finish.
				posX += listener._position[0];
				posY += listener._position[1];
				posZ += listener._position[2];
			}

			if (panner.positionX) {
				panner.positionX.value = posX;
				panner.positionY.value = posY;
				panner.positionZ.value = posZ;
			} else {
#if OPENAL_DEBUG
				Runtime.warnOnce("Panner position attributes are not present, falling back to setPosition()");
#endif
				panner.setPosition(src.position[0], src.position[1], src.position[2]);
			}
			if (panner.orientationX) {
				panner.orientationX.value = dirX;
				panner.orientationY.value = dirY;
				panner.orientationZ.value = dirZ;
			} else {
#if OPENAL_DEBUG
				Runtime.warnOnce("Panner orientation attributes are not present, falling back to setOrientation()");
#endif
				panner.setOrientation(val[0], val[1], val[2]);
			}

			// TODO: If support for doppler effect is reintroduced, compute the doppler
			// speed pitch factor and apply it here.
		},

		sourceLength: function(src) {
			var length = 0.0;
			for (i = 0; i < src.bufQueue.length; i++) {
				length += src.bufQueue[i].audioBuf.duration;
			}
			return length;
		},

		sourceTell: function(src) {
			AL.updateSourceTime(src);

			var offset = 0.0;
			for (i = 0; i < src.bufsProcessed; i++) {
				offset += src.bufQueue[i].audioBuf.duration;
			}
			offset += src.bufOffset;

			return offset;
		},

		sourceSeek: function(src, offset) {
			var playing = src.state == 0x1012 /* AL_PLAYING */;
			if (playing) {
				AL.setSourceState(src, 0x1011 /* AL_INITIAL */);
			}

			src.bufsProcessed = 0;
			while (offset > src.bufQueue[src.bufsProcessed].audioBuf.duration) {
				offset -= src.bufQueue[src.bufsProcessed].audiobuf.duration;
				src.bufsProcessed++;
			}

			src.bufOffset = offset;
			if (playing) {
				AL.setSourceState(src, 0x1012 /* AL_PLAYING */);
			}
		},

		// ------------------------------------------------------
		// -- Accessor Helpers
		// ------------------------------------------------------

		getDoubleHelper: function(funcname, param) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return null;
			}
			// Right now, none of these can be set, so we directly return
			// the values we support.
			switch (param) {
			case 0xC000 /* AL_DOPPLER_FACTOR */:
				return 1.0;
			case 0xC003 /* AL_SPEED_OF_SOUND */:
				return 343.3;
			case 0xD000 /* AL_DISTANCE_MODEL */:
				return 0 /* AL_NONE */;
			default:
#if OPENAL_DEBUG
				console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return null;
			}
		},

		doubleHelper: function(funcname, param, value) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}

			switch (param) {
			case 0xC000 /* AL_DOPPLER_FACTOR */:
				Runtime.warnOnce("alDopplerFactor() is not yet implemented!");
				if (value < 0.0) { // Strictly negative values are disallowed
#if OPENAL_DEBUG
					console.error(funcname + "() value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				// TODO actual impl here
				return;
			case 0xC003 /* AL_SPEED_OF_SOUND */:
				Runtime.warnOnce("alSpeedOfSound() is not yet implemented!");
				if (value <= 0.0) { // Negative or zero values are disallowed
#if OPENAL_DEBUG
					console.error(funcname + "() value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				// TODO actual impl here
				return;
			case 0xD000 /* AL_DISTANCE_MODEL */:
				if (value !== 0 /* AL_NONE */) {
#if OPENAL_DEBUG
					console.error(funcname + "() value " + value + " is out of range");
#endif
#if OPENAL_DEBUG
					Runtime.warnOnce("Only alDistanceModel(AL_NONE) is currently supported");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
				}
				// TODO actual impl here
				return;
			default:
#if OPENAL_DEBUG
				console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				break;
			}
		},

		getListenerHelper: function(funcname, param) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return null;
			}

			switch (param) {
			case 0x1004 /* AL_POSITION */:
				return AL.currentCtx.audioCtx.listener._position;
			case 0x1006 /* AL_VELOCITY */:
				return AL.currentCtx.audioCtx.listener._velocity;
			case 0x100F /* AL_ORIENTATION */:
				return AL.currentCtx.audioCtx.listener._direction.concat(AL.currentCtx.audioCtx.listener._up);
			case 0x100A /* AL_GAIN */:
				return AL.currentCtx.gain.gain.value;
			default:
#if OPENAL_DEBUG
				console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return null;
			}
		},

		listenerHelper: function(funcname, param, value) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}
			if (value === null) {
#if OPENAL_DEBUG
				console.error(funcname + "(): param 0x" + param.toString(16) + " has wrong signature");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return;
			}

			var listener = AL.currentCtx.audioCtx.listener;
			switch (param) {
			case 0x1004 /* AL_POSITION */:
				listener._position = value;
				AL.updateListenerSpace(AL.currentCtx);
				return;
			case 0x1006 /* AL_VELOCITY */:
				listener._velocity = value;
				AL.updateListenerSpace(AL.currentCtx);
				return;
			case 0x100A /* AL_GAIN */:
				if (value < 0.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				AL.currentCtx.gain.gain.value = value;
				return;
			case 0x100F /* AL_ORIENTATION */:
				listener._direction = value.slice(0, 3);
				listener._up = value.slice(3, 6);
				AL.updateListenerSpace(AL.currentCtx);
				return;
			default:
#if OPENAL_DEBUG
				console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return;
			}
		},

		getBufferHelper: function(funcname, bufferId, param) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}
			var buf = AL.buffers[bufferId - 1];
			if (!buf) {
#if OPENAL_DEBUG
				console.error(funcname + "() called with an invalid buffer");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}

			switch (param) {
			case 0x2001 /* AL_FREQUENCY */:
				return buf.audioBuf.sampleRate;
			case 0x2002 /* AL_BITS */:
				return buf.audioBuf._bytesPerSample * 8;
			case 0x2003 /* AL_CHANNELS */:
				return buf.audioBuf.numberOfChannels;
			case 0x2004 /* AL_SIZE */:
				return buf.audioBuf.length * buf.audioBuf._bytesPerSample * buf.audioBuf.numberOfChannels;
			default:
#if OPENAL_DEBUG
				console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return null;
			}
		},

		bufferHelper: function(funcname, bufferId, param, value) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}
			var buf = AL.buffers[bufferId - 1];
			if (!buf) {
#if OPENAL_DEBUG
				console.error(funcname + "() called with an invalid buffer");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
			if (value === null) {
#if OPENAL_DEBUG
				console.error(funcname + "(): param 0x" + param.toString(16) + " has wrong signature");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return;
			}

#if OPENAL_DEBUG
			console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
		},

		getSourceHelper: function(funcname, sourceId, param) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return null;
			}
			var src = AL.currentCtx.src[sourceId - 1];
			if (!src) {
#if OPENAL_DEBUG
				console.error(funcname + "() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return null;
			}

			switch (param) {
			case 0x202 /* AL_SOURCE_RELATIVE */:
				return src.relative;
			case 0x1001 /* AL_CONE_INNER_ANGLE */:
				return src.coneInnerAngle;
			case 0x1002 /* AL_CONE_OUTER_ANGLE */:
				return src.coneOuterAngle;
			case 0x1003 /* AL_PITCH */:
				return src.playbackRate;
			case 0x1004 /* AL_POSITION */:
				return src.position;
			case 0x1005 /* AL_DIRECTION */:
				return src.direction;
			case 0x1006 /* AL_VELOCITY */:
				return src.velocity;
			case 0x1007 /* AL_LOOPING */:
				return src.loop;
			case 0x1009 /* AL_BUFFER */:
				if (src.type === 0x1028 /* AL_STATIC */) {
					return src.bufQueue[0].id;
				} else {
					return 0;
				}
			case 0x100A /* AL_GAIN */:
				return src.gain.gain.value;
			 case 0x100D /* AL_MIN_GAIN */:
				return src.minGain;
			case 0x100E /* AL_MAX_GAIN */:
				return src.maxGain;
			case 0x1010 /* AL_SOURCE_STATE */:
				return src.state;
			case 0x1015 /* AL_BUFFERS_QUEUED */:
				return src.bufQueue.length;
			case 0x1016 /* AL_BUFFERS_PROCESSED */:
				if (src.loop) {
					return 0;
				} else {
					return src.bufsProcessed;
				}
			case 0x1020 /* AL_REFERENCE_DISTANCE */:
				return src.refDistance;
			case 0x1021 /* AL_ROLLOFF_FACTOR */:
				return src.rolloffFactor;
			case 0x1022 /* AL_CONE_OUTER_GAIN */:
				return src.coneOuterGain;
			case 0x1023 /* AL_MAX_DISTANCE */:
				return src.maxDistance;
			case 0x1024 /* AL_SEC_OFFSET */:
				return AL.sourceTell(src);
			case 0x1025 /* AL_SAMPLE_OFFSET */:
				var offset = AL.sourceTell(src);
				if (offset > 0.0) {
					offset *= src.bufQueue[0].audioBuf.sampleRate;
				}
				return offset;
			case 0x1026 /* AL_BYTE_OFFSET */:
				var offset = AL.sourceTell(src);
				if (offset > 0.0) {
					offset *= src.bufQueue[0].audioBuf.sampleRate * src.bufQueue[0].audioBuf._bytesPerSample;
				}
				return offset;
			case 0x1027 /* AL_SOURCE_TYPE */:
				return src.type;
			default:
#if OPENAL_DEBUG
				console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return null;
			}
		},

		sourceHelper: function(funcname, sourceId, param, value) {
			if (!AL.currentCtx) {
#if OPENAL_DEBUG
				console.error(funcname + "() called without a valid context");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}
			var src = AL.currentCtx.sources[sourceId - 1];
			if (!src) {
#if OPENAL_DEBUG
				console.error("alSourcef() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
			if (value === null) {
#if OPENAL_DEBUG
				console.error(funcname + "(): param 0x" + param.toString(16) + " has wrong signature");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return;
			}

			switch (param) {
			case 0x202 /* AL_SOURCE_RELATIVE */:
				if (value === 1 /* AL_TRUE */) {
					src.relative = true;
				} else if (value === 0 /* AL_FALSE */) {
					src.relative = false;
				} else {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				return;
			case 0x1001 /* AL_CONE_INNER_ANGLE */:
				src.coneInnerAngle = value;
				return;
			case 0x1002 /* AL_CONE_OUTER_ANGLE */:
				src.coneOuterAngle = value;
				return;
			case 0x1003 /* AL_PITCH */:
				if (value <= 0.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}

				if (src.playbackRate === value) {
					return;
				}
				src.playbackRate = value;

				if (src.state === 0x1012 /* AL_PLAYING */) {
					// clear scheduled buffers
					AL.cancelPendingSourceAudio(src);

					var audioSrc = src.audioQueue[0];
					if (!audioSrc) {
						return; // It is possible that AL.scheduleContextAudio() has not yet fed the next buffer, if so, skip.
					}
					var oldrate = audioSrc.playbackRate.value;
					// audioSrc._duration is expressed after factoring in playbackRate, so when changing playback rate, need
					// to recompute/rescale the rate to the new playback speed.
					audioSrc._duration = audioSrc._duration * oldrate / src.playbackRate;
					audioSrc.playbackRate.value = src.playbackRate;

					// reschedule buffers with the new playbackRate
					AL.scheduleSourceAudio(src);
				}
				return;
			case 0x1004 /* AL_POSITION */:
				src.position = values;
				AL.updateSourceSpace(src);
				return;
			case 0x1005 /* AL_DIRECTION */:
				src.direction = values;
				AL.updateSourceSpace(src);
				return;
			case 0x1006 /* AL_VELOCITY */:
				src.velocity = values;
				AL.updateSourceSpace(src);
				return;
			case 0x1007 /* AL_LOOPING */:
				if (value === 1 /* AL_TRUE */) {
					src.loop = true;
				} else if (value === 0 /* AL_FALSE */) {
					src.loop = false;
				} else {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				return;
			case 0x1009 /* AL_BUFFER */:
				if (src.state === 0x1012 /* AL_PLAYING */ || src.state === 0x1013 /* AL_PAUSED */) {
#if OPENAL_DEBUG
					console.error(funcname + "(AL_BUFFER) called while source is playing or paused");
#endif
					AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
					return;
				}

				if (value === 0) {
					for (var i in src.bufQueue) {
						src.bufQueue[i].refCount--;
					}
					src.bufQueue.length = 0;

					src.bufsProcessed = 0;
					src.type = 0x1030 /* AL_UNDETERMINED */;
				} else {
					var buf = AL.buffers[value - 1];
					if (!buf) {
#if OPENAL_DEBUG
						console.error("alSourcei(AL_BUFFER) called with an invalid buffer");
#endif
						AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
						return;
					}

					for (var i in src.bufQueue) {
						src.bufQueue[i].refCount--;
					}
					src.bufQueue.length = 0;

					buf.refCount++;
					src.bufQueue = [buf];
					src.bufsProcessed = 0;
					src.type = 0x1028 /* AL_STATIC */;
				}

				AL.initSourcePanner(src);
				AL.scheduleSourceAudio(src);
				return;
			case 0x100A /* AL_GAIN */:
				if (value < 0.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				src.gain.gain.value = value;
				return;
			case 0x100D /* AL_MIN_GAIN */:
				if (value < 0.0 || value > Math.min(src.maxGain, 1.0)) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
#if OPENAL_DEBUG
				Runtime.warnOnce("AL_MIN_GAIN is not currently supported");
#endif
				src.minGain = value;
				return;
			case 0x100E /* AL_MAX_GAIN */:
				if (value < Math.max(0.0, src.minGain) || value > 1.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
#if OPENAL_DEBUG
				Runtime.warnOnce("AL_MAX_GAIN is not currently supported");
#endif
				src.maxGain = value;
				return;
			case 0x1020 /* AL_REFERENCE_DISTANCE */:
				if (value < 0.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				src.refDistance = value;
				return;
			case 0x1021 /* AL_ROLLOFF_FACTOR */:
				if (value < 0.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				src.rolloffFactor = value;
				return;
			case 0x1022 /* AL_CONE_OUTER_GAIN */:
				if (value < 0.0 || value > 1.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				src.coneOuterGain = value;
				return;
			case 0x1023 /* AL_MAX_DISTANCE */:
				if (value < 0.0) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}
				src.maxDistance = value;
				return;
			case 0x1024 /* AL_SEC_OFFSET */:
				if (value < 0.0 || value > AL.sourceLength(src)) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}

				AL.sourceSeek(src, value);
				return;
			case 0x1025 /* AL_SAMPLE_OFFSET */:
				if (src.bufQueue.length > 0) {
					value /= src.bufQueue[0].audioBuf.sampleRate;
				}
				if (value < 0.0 || value > AL.sourceLength(src)) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}

				AL.sourceSeek(src, value);
				return;
			case 0x1026 /* AL_BYTE_OFFSET */:
				if (src.bufQueue.length > 0) {
					value /= src.bufQueue[0].audioBuf.sampleRate * src.bufQueue[0].audioBuf._bytesPerSample;
				}
				if (value < 0.0 || value > AL.sourceLength(src)) {
#if OPENAL_DEBUG
					console.error(funcname + "() param 0x" + param.toString(16) + " value " + value + " is out of range");
#endif
					AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
					return;
				}

				AL.sourceSeek(src, value);
				return;
			default:
#if OPENAL_DEBUG
				console.error(funcname + "() param 0x" + param.toString(16) + " is unknown or not implemented");
#endif
				AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
				return;
			}
		}
	},

	// ***************************************************************************
	// ** ALC API 
	// ***************************************************************************

	// -------------------------------------------------------
	// -- ALC Resources
	// -------------------------------------------------------

	alcOpenDevice: function(pDeviceName) {
		if (typeof(AudioContext) !== "undefined" || typeof(webkitAudioContext) !== "undefined") {
			return 1; // non-null pointer -- we just simulate one device
		} else {
			return 0;
		}
	},

	alcCloseDevice: function(deviceId) {
		// Stop playback, etc
	},

	alcCreateContext: function(deviceId, pAttrList) {
		if (deviceId != 1) {
#if OPENAL_DEBUG
			console.log("alcCreateContext() called with an invalid device");
#endif
			AL.alcErr = 0xA001; /* ALC_INVALID_DEVICE */
			return 0;
		}

		if (pAttrList) {
#if OPENAL_DEBUG
			console.log("The pAttrList argument of alcCreateContext is not supported yet");
#endif
			AL.alcErr = 0xA004; /* ALC_INVALID_VALUE */
			return 0;
		}

		var ac;
		try {
			ac = new AudioContext();
		} catch (e) {
			try {
				ac = new webkitAudioContext();
			} catch (e) {}
		}

		if (ac) {
			// Old Web Audio API (e.g. Safari 6.0.5) had an inconsistently named createGainNode function.
			if (typeof(ac.createGain) === "undefined") {
				ac.createGain = ac.createGainNode;
			}

			var gain = ac.createGain();
			gain.connect(ac.destination);
			// Extend the Web Audio API AudioListener object with a few tracking values of our own.
			ac.listener._position = [0.0, 0.0, 0.0];
			ac.listener._velocity = [0.0, 0.0, 0.0];
			ac.listener._direction = [0.0, 0.0, 0.0];
			ac.listener._up = [0.0, 0.0, 0.0];
			var context = {
				id: AL.contexts.length + 1,
				audioCtx: ac,
				_err: 0,
				get err() {
					return this._err;
				},
				set err(val) {
					// Errors should not be overwritten by later errors until they are cleared by a query.
					if (this._err === 0 /* AL_NO_ERROR */) {
						this._err = val;
					}
				},
				sources: [],
				interval: setInterval(function() { AL.scheduleContextAudio(context); }, AL.QUEUE_INTERVAL),
				gain: gain
			};
			AL.contexts.push(context);
			return context.id;
		} else {
			AL.alcErr = 0xA001; /* ALC_INVALID_DEVICE */
			return 0;
		}
	},

	alcDestroyContext: function(contextId) {
		var ctx = AL.contexts[contextId - 1];
		if (AL.currentCtx === ctx) {
#if OPENAL_DEBUG
			console.log("alcDestroyContext() called with an invalid context");
#endif
			AL.alcErr = 0xA002 /* ALC_INVALID_CONTEXT */;
			return;
		}

		// Stop playback, etc
		clearInterval(AL.contexts[contextId - 1].interval);
		delete AL.contexts[contextId - 1];
	},

	// Might be very interesting to implement that !
	alcCaptureOpenDevice: function(pDeviceName, freq, format, bufferSize) {
		Runtime.warnOnce("alcCapture*() functions are not supported yet.");
#if OPENAL_DEBUG
		console.error("alcCaptureOpenDevice() is not supported yet");
#endif
		// From the programmer"s guide, ALC_OUT_OF_MEMORY"s meaning is
		// overloaded here, to mean:
		// "The specified device is invalid, or can not capture audio."
		// This may be misleading to API users, but well...
		AL.alcErr = 0xA005 /* ALC_OUT_OF_MEMORY */;
		return 0; // NULL device pointer
	},

	alcCaptureCloseDevice: function(deviceId) {
#if OPENAL_DEBUG
		console.error("alcCaptureCloseDevice() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
		return false;
	},

	// -------------------------------------------------------
	// -- ALC State
	// -------------------------------------------------------

	alcGetError: function(deviceId) {
		var err = AL.alcErr;
		AL.alcErr = 0 /* ALC_NO_ERROR */;
		return err;
	},

	alcGetCurrentContext: function() {
		if (AL.currentCtx !== null) {
			return AL.currentCtx.id;
		} else {
			return 0;
		}
	},

	alcMakeContextCurrent: function(contextId) {
		if (contextId === 0) {
			AL.currentCtx = null;
			return 0;
		} else {
			AL.currentCtx = AL.contexts[contextId - 1];
			return 1;
		}
	},

	alcGetContextsDevice: function(contextId) {
		if (contextId <= AL.contexts.length && contextId > 0) {
			// Returns the only one audio device
			return 1;
		}
		return 0;
	},

	alcProcessContext: function(contextId) {},
	alcSuspendContext: function(contextId) {},

	alcCaptureStart: function(deviceId) {
#if OPENAL_DEBUG
		console.error("alcCaptureStart() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
	},

	alcCaptureStop: function(deviceId) {
#if OPENAL_DEBUG
		console.error("alcCaptureStop() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
	},

	alcCaptureSamples: function(deviceId, pSamples, nSamples) {
#if OPENAL_DEBUG
		console.error("alcCaptureSamples() is not supported yet");
#endif
		AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
	},

	alcIsExtensionPresent: function(deviceId, pExtName) {
		return 0;
	},

	alcGetProcAddress: function(deviceId, pProcName) {
		return 0;
	},

	alcGetEnumValue: function(deviceId, pEnumName) {
		// Spec says :
		// Using a NULL handle is legal, but only the
		// tokens defined by the AL core are guaranteed.
		if (deviceId !== 0 && deviceId !== 1) {
#if OPENAL_DEBUG
			console.error("alcGetEnumValue() called with an invalid device");
#endif
			// ALC_INVALID_DEVICE is not listed as a possible error state for
			// this function, sadly.
			return 0 /* AL_NONE */;
		} else if (!pEnumName) {
			AL.alcErr = 0xA004 /* ALC_INVALID_VALUE */;
			return 0; /* AL_NONE */
		}
		name = Pointer_stringify(pEnumName);
		// See alGetEnumValue(), but basically behave the same as OpenAL-Soft
		switch(name) {
		case "ALC_NO_ERROR": return 0;
		case "ALC_INVALID_DEVICE": return 0xA001;
		case "ALC_INVALID_CONTEXT": return 0xA002;
		case "ALC_INVALID_ENUM": return 0xA003;
		case "ALC_INVALID_VALUE": return 0xA004;
		case "ALC_OUT_OF_MEMORY": return 0xA005;
		case "ALC_MAJOR_VERSION": return 0x1000;
		case "ALC_MINOR_VERSION": return 0x1001;
		case "ALC_ATTRIBUTES_SIZE": return 0x1002;
		case "ALC_ALL_ATTRIBUTES": return 0x1003;
		case "ALC_DEFAULT_DEVICE_SPECIFIER": return 0x1004;
		case "ALC_DEVICE_SPECIFIER": return 0x1005;
		case "ALC_EXTENSIONS": return 0x1006;
		case "ALC_FREQUENCY": return 0x1007;
		case "ALC_REFRESH": return 0x1008;
		case "ALC_SYNC": return 0x1009;
		case "ALC_MONO_SOURCES": return 0x1010;
		case "ALC_STEREO_SOURCES": return 0x1011;
		case "ALC_CAPTURE_DEVICE_SPECIFIER": return 0x310;
		case "ALC_CAPTURE_DEFAULT_DEVICE_SPECIFIER": return 0x311;
		case "ALC_CAPTURE_SAMPLES": return 0x312;
		default:
#if OPENAL_DEBUG
			console.error("No value for `" + pEnumName + "` is known by alcGetEnumValue()");
#endif
			AL.alcErr = 0xA004 /* ALC_INVALID_VALUE */;
			return 0 /* AL_NONE */;
		}
	},

	alcGetString: function(deviceId, param) {
		if (AL.alcStringCache[param]) return AL.alcStringCache[param];
		var ret;
		switch (param) {
		case 0 /* ALC_NO_ERROR */:
			ret = "No Error";
			break;
		case 0xA001 /* ALC_INVALID_DEVICE */:
			ret = "Invalid Device";
			break;
		case 0xA002 /* ALC_INVALID_CONTEXT */:
			ret = "Invalid Context";
			break;
		case 0xA003 /* ALC_INVALID_ENUM */:
			ret = "Invalid Enum";
			break;
		case 0xA004 /* ALC_INVALID_VALUE */:
			ret = "Invalid Value";
			break;
		case 0xA005 /* ALC_OUT_OF_MEMORY */:
			ret = "Out of Memory";
			break;
		case 0x1004 /* ALC_DEFAULT_DEVICE_SPECIFIER */:
			if (typeof(AudioContext) !== "undefined" ||
					typeof(webkitAudioContext) !== "undefined") {
				ret = "Device";
			} else {
				return 0;
			}
			break;
		case 0x1005 /* ALC_DEVICE_SPECIFIER */:
			if (typeof(AudioContext) !== "undefined" ||
					typeof(webkitAudioContext) !== "undefined") {
				ret = "Device\0";
			} else {
				ret = "\0";
			}
			break;
		case 0x311 /* ALC_CAPTURE_DEFAULT_DEVICE_SPECIFIER */:
			return 0;
			break;
		case 0x310 /* ALC_CAPTURE_DEVICE_SPECIFIER */:
			ret = "\0"
			break;
		case 0x1006 /* ALC_EXTENSIONS */:
			if (!deviceId) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			ret = "";
			break;
		default:
			AL.alcErr = 0xA003 /* ALC_INVALID_ENUM */;
			return 0;
		}

		ret = allocate(intArrayFromString(ret), "i8", ALLOC_NORMAL);

		AL.alcStringCache[param] = ret;

		return ret;
	},

	alcGetIntegerv: function(deviceId, param, size, pValues) {
		if (size === 0 || !pValues) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch(param) {
		case 0x1000 /* ALC_MAJOR_VERSION */:
			{{{ makeSetValue("pValues", "0", "1", "i32") }}};
			break;
		case 0x1001 /* ALC_MINOR_VERSION */:
			{{{ makeSetValue("pValues", "0", "1", "i32") }}};
			break;
		case 0x1002 /* ALC_ATTRIBUTES_SIZE */:
			if (!deviceId) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("pValues", "0", "1", "i32") }}};
			break;
		case 0x1003 /* ALC_ALL_ATTRIBUTES */:
			if (!deviceId) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("pValues", "0", "0", "i32") }}};
			break;
		case 0x1007 /* ALC_FREQUENCY */:
			if (!deviceId) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			if (!AL.currentCtx) {
				AL.alcErr = 0xA002 /* ALC_INVALID_CONTEXT */;
				return 0;
			}
			{{{ makeSetValue("pValues", "0", "AL.currentCtx.audioCtx.sampleRate", "i32") }}};
			break;
		case 0x1010 /* ALC_MONO_SOURCES */:
		case 0x1011 /* ALC_STEREO_SOURCES */:
			if (!deviceId) {
				AL.alcErr = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("pValues", "0", "0x7FFFFFFF", "i32") }}};
			break;
		case 0x20003 /* ALC_MAX_AUXILIARY_SENDS */:
			if (!deviceId) {
				AL.currentCtx.err = 0xA001 /* ALC_INVALID_DEVICE */;
				return 0;
			}
			{{{ makeSetValue("pValues", "0", "1", "i32") }}};
		default:
#if OPENAL_DEBUG
			console.log("alcGetIntegerv() with param 0x" + param.toString(16) + " not implemented yet");
#endif
			AL.alcErr = 0xA003 /* ALC_INVALID_ENUM */;
			break;
		}
	},

	// ***************************************************************************
	// ** AL API 
	// ***************************************************************************

	// -------------------------------------------------------
	// -- AL Resources
	// -------------------------------------------------------

	alGenBuffers: function(count, pBufferIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGenBuffers() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}

		for (var i = 0; i < count; ++i) {
			var buf = {
				id: AL.buffers.length + 1,
				refCount: 0,
				audioBuf: null
			};
			AL.buffers.push(buf);
			{{{ makeSetValue("pBufferIds", "i*4", "buf.id", "i32") }}};
		}
	},

	alDeleteBuffers: function(count, pBufferIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDeleteBuffers() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (count > AL.buffers.length) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		for (var i = 0; i < count; ++i) {
			var bufId = {{{ makeGetValue("pBufferIds", "i*4", "i32") }}};
			/// Deleting the 0 buffer is a legal NOP, so ignore it
			if (bufId === 0) {
				continue;
			}

			// Make sure the buffer index is valid.
			if (!AL.buffers[bufId - 1]) {
#if OPENAL_DEBUG
				console.error("alDeleteBuffers() called with an invalid buffer");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}

			// Make sure the buffer is no longer in use.
			if (AL.buffers[bufId - 1].refCount) {
#if OPENAL_DEBUG
				console.error("alDeleteBuffers() called with a used buffer");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			var bufId = {{{ makeGetValue("pBufferIds", "i*4", "i32") }}};
			if (bufId === 0) {
				continue;
			}

			delete AL.buffers[bufId - 1];
		}
	},

	alGenSources: function(count, pSourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGenSources() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		for (var i = 0; i < count; ++i) {
			var gain = AL.currentCtx.audioCtx.createGain();
			gain.connect(AL.currentCtx.gain);
			var src = {
				context: AL.currentCtx,
				id: AL.currentCtx.sources.length + 1,
				type: 0x1030 /* AL_UNDETERMINED */,
				state: 0x1011 /* AL_INITIAL */,
				bufQueue: [],
				audioQueue: [],
				loop: false,
				playbackRate: 1.0,
				gain: gain,
				minGain: 0.0,
				maxGain: 1.0,
				panner: null,
				bufsProcessed: 0,
				bufStartTime: Number.NEGATIVE_INFINITY,
				bufOffset: 0.0,

				_relative: false,
				get relative() {
					return this._relative;
				},
				set relative(val) {
					this._relative = val;
					AL.updateSourceSpace(this);
				},

				_refDistance: 1.0,
				get refDistance() {
					return this._refDistance;
				},
				set refDistance(val) {
					this._refDistance = val;
					if (this.panner) {
						this.panner.refDistance = val;
					}
				},

				_maxDistance: 3.40282347e38 /* FLT_MAX */,
				get maxDistance() {
					return this._maxDistance;
				},
				set maxDistance(val) {
					this._maxDistance = val;
					if (this.panner) {
						this.panner.maxDistance = val;
					}
				},

				_rolloffFactor: 1.0,
				get rolloffFactor() {
					return this._rolloffFactor;
				},
				set rolloffFactor(val) {
					this._rolloffFactor = val;
					if (this.panner) {
						this.panner.rolloffFactor = val;
					}
				},

				_position: [0.0, 0.0, 0.0],
				get position() {
					return this._position;
				},
				set position(val) {
					this._position[0] = val[0];
					this._position[1] = val[1];
					this._position[2] = val[2];
					AL.updateSourceSpace(this);
				},

				_velocity: [0.0, 0.0, 0.0],
				get velocity() {
					return this._velocity;
				},
				set velocity(val) {
					this._velocity[0] = val[0];
					this._velocity[1] = val[1];
					this._velocity[2] = val[2];
					AL.updateSourceSpace(this);
				},

				_direction: [0.0, 0.0, 0.0],
				get direction() {
					return this._direction;
				},
				set direction(val) {
					this._direction[0] = val[0];
					this._direction[1] = val[1];
					this._direction[2] = val[2];
					AL.updateSourceSpace(this);
				},

				_coneOuterGain: 0.0,
				get coneOuterGain() {
					return this._coneOuterGain;
				},
				set coneOuterGain(val) {
					this._coneOuterGain = val;
					if (this.panner) {
						this.panner.coneOuterGain = val;
					}
				},

				_coneInnerAngle: 360.0,
				get coneInnerAngle() {
					return this._coneInnerAngle;
				},
				set coneInnerAngle(val) {
					this._coneInnerAngle = val;
					if (this.panner) {
						this.panner.coneInnerAngle = val;
					}
				},

				_coneOuterAngle: 360.0,
				get coneOuterAngle() {
					return this._coneOuterAngle;
				},
				set coneOuterAngle(val) {
					this._coneOuterAngle = val;
					if (this.panner) {
						this.panner.coneOuterAngle = val;
					}
				}
			};
			AL.currentCtx.sources.push(src);
			{{{ makeSetValue("pSourceIds", "i*4", "src.id", "i32") }}};
		}
	},

	alDeleteSources__deps: ["alSourcei"],
	alDeleteSources: function(count, pSourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDeleteSources() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}

		for (var i = 0; i < count; ++i) {
			var srcId = {{{ makeGetValue("pSourceIds", "i*4", "i32") }}};
			if (!AL.currentCtx.sources[srcId - 1]) {
#if OPENAL_DEBUG
				console.error("alDeleteSources() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			var srcId = {{{ makeGetValue("pSourceIds", "i*4", "i32") }}};
			AL.setSourceState(AL.currentCtx.sources[srcId - 1], 0x1014 /* AL_STOPPED */);
			_alSourcei(srcId, 0x1009 /* AL_BUFFER */, 0);
			delete AL.currentCtx.sources[srcId - 1];
		}
	},

	// -------------------------------------------------------
	// --- AL Context State
	// -------------------------------------------------------

	alGetError: function() {
		if (!AL.currentCtx) {
			return 0xA004 /* AL_INVALID_OPERATION */;
		} else {
			// Reset error on get.
			var err = AL.currentCtx.err;
			AL.currentCtx.err = 0 /* AL_NO_ERROR */;
			return err;
		}
	},

	alIsExtensionPresent: function(pExtName) {
		name = Pointer_stringify(pExtName);

		if (name === "AL_EXT_float32") return 1;

		return 0;
	},

	alGetProcAddress: function(pProcName) {
		return 0;
	},

	alGetEnumValue: function(pEnumName) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetEnumValue() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return 0;
		}

		if (!pEnumName) {
#if OPENAL_DEBUG
			console.error("alGetEnumValue() called with null pointer");
#endif
			return 0 /* AL_NONE */;
		}
		name = Pointer_stringify(pEnumName);

		switch(name) {
		case "AL_FORMAT_MONO_FLOAT32": return 0x10010;
		case "AL_FORMAT_STEREO_FLOAT32": return 0x10011;

		// Spec doesn't clearly state that alGetEnumValue() is required to
		// support _only_ extension tokens.
		// We should probably follow OpenAL-Soft"s example and support all
		// of the names we know.
		// See http://repo.or.cz/openal-soft.git/blob/HEAD:/Alc/ALc.c
		case "AL_BITS": return 0x2002;
		case "AL_BUFFER": return 0x1009;
		case "AL_BUFFERS_PROCESSED": return 0x1016;
		case "AL_BUFFERS_QUEUED": return 0x1015;
		case "AL_BYTE_OFFSET": return 0x1026;
		case "AL_CHANNELS": return 0x2003;
		case "AL_CONE_INNER_ANGLE": return 0x1001;
		case "AL_CONE_OUTER_ANGLE": return 0x1002;
		case "AL_CONE_OUTER_GAIN": return 0x1022;
		case "AL_DIRECTION": return 0x1005;
		case "AL_DISTANCE_MODEL": return 0xD000;
		case "AL_DOPPLER_FACTOR": return 0xC000;
		case "AL_DOPPLER_VELOCITY": return 0xC001;
		case "AL_EXPONENT_DISTANCE": return 0xD005;
		case "AL_EXPONENT_DISTANCE_CLAMPED": return 0xD006;
		case "AL_EXTENSIONS": return 0xB004;
		case "AL_FORMAT_MONO16": return 0x1101;
		case "AL_FORMAT_MONO8": return 0x1100;
		case "AL_FORMAT_STEREO16": return 0x1103;
		case "AL_FORMAT_STEREO8": return 0x1102;
		case "AL_FREQUENCY": return 0x2001;
		case "AL_GAIN": return 0x100A;
		case "AL_INITIAL": return 0x1011;
		case "AL_INVALID": return -1;
		case "AL_ILLEGAL_ENUM": // fallthrough
		case "AL_INVALID_ENUM": return 0xA002;
		case "AL_INVALID_NAME": return 0xA001;
		case "AL_ILLEGAL_COMMAND": // fallthrough
		case "AL_INVALID_OPERATION": return 0xA004;
		case "AL_INVALID_VALUE": return 0xA003;
		case "AL_INVERSE_DISTANCE": return 0xD001;
		case "AL_INVERSE_DISTANCE_CLAMPED": return 0xD002;
		case "AL_LINEAR_DISTANCE": return 0xD003;
		case "AL_LINEAR_DISTANCE_CLAMPED": return 0xD004;
		case "AL_LOOPING": return 0x1007;
		case "AL_MAX_DISTANCE": return 0x1023;
		case "AL_MAX_GAIN": return 0x100E;
		case "AL_MIN_GAIN": return 0x100D;
		case "AL_NONE": return 0;
		case "AL_NO_ERROR": return 0;
		case "AL_ORIENTATION": return 0x100F;
		case "AL_OUT_OF_MEMORY": return 0xA005;
		case "AL_PAUSED": return 0x1013;
		case "AL_PENDING": return 0x2011;
		case "AL_PITCH": return 0x1003;
		case "AL_PLAYING": return 0x1012;
		case "AL_POSITION": return 0x1004;
		case "AL_PROCESSED": return 0x2012;
		case "AL_REFERENCE_DISTANCE": return 0x1020;
		case "AL_RENDERER": return 0xB003;
		case "AL_ROLLOFF_FACTOR": return 0x1021;
		case "AL_SAMPLE_OFFSET": return 0x1025;
		case "AL_SEC_OFFSET": return 0x1024;
		case "AL_SIZE": return 0x2004;
		case "AL_SOURCE_RELATIVE": return 0x202;
		case "AL_SOURCE_STATE": return 0x1010;
		case "AL_SOURCE_TYPE": return 0x1027;
		case "AL_SPEED_OF_SOUND": return 0xC003;
		case "AL_STATIC": return 0x1028;
		case "AL_STOPPED": return 0x1014;
		case "AL_STREAMING": return 0x1029;
		case "AL_UNDETERMINED": return 0x1030;
		case "AL_UNUSED": return 0x2010;
		case "AL_VELOCITY": return 0x1006;
		case "AL_VENDOR": return 0xB001;
		case "AL_VERSION": return 0xB002;
		}

#if OPENAL_DEBUG
		console.error("No value for `" + name + "` is known by alGetEnumValue()");
#endif
		AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		return 0;
	},

	alGetString: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alGetString() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (AL.stringCache[param]) return AL.stringCache[param];
		var ret;
		switch (param) {
		case 0 /* AL_NO_ERROR */:
			ret = "No Error";
			break;
		case 0xA001 /* AL_INVALID_NAME */:
			ret = "Invalid Name";
			break;
		case 0xA002 /* AL_INVALID_ENUM */:
			ret = "Invalid Enum";
			break;
		case 0xA003 /* AL_INVALID_VALUE */:
			ret = "Invalid Value";
			break;
		case 0xA004 /* AL_INVALID_OPERATION */:
			ret = "Invalid Operation";
			break;
		case 0xA005 /* AL_OUT_OF_MEMORY */:
			ret = "Out of Memory";
			break;
		case 0xB001 /* AL_VENDOR */:
			ret = "Emscripten";
			break;
		case 0xB002 /* AL_VERSION */:
			ret = "1.1";
			break;
		case 0xB003 /* AL_RENDERER */:
			ret = "WebAudio";
			break;
		case 0xB004 /* AL_EXTENSIONS */:
			ret = "AL_EXT_float32";
			break;
		default:
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return 0;
		}

		ret = allocate(intArrayFromString(ret), "i8", ALLOC_NORMAL);

		AL.stringCache[param] = ret;

		return ret;
	},

	alEnable: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alEnable() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		switch (param) {
		default:
#if OPENAL_DEBUG
			console.error("alEnable() with param 0x" + param.toString(16) + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alDisable: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDisable() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		switch (pname) {
		default:
#if OPENAL_DEBUG
			console.error("alDisable() with param 0x" + param.toString(16) + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}
	},

	alIsEnabled: function(param) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alIsEnabled() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return 0;
		}
		switch (pname) {
		default:
#if OPENAL_DEBUG
			console.error("alIsEnabled() with param 0x" + param.toString(16) + " not implemented yet");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			break;
		}

		return 0;
	},

	alGetDouble: function(param) {
		var val = AL.getDoubleHelper("alGetDouble", param);
		if (val === null) {
			return 0.0;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			return val;
		default:
#if OPENAL_DEBUG
			console.error("alGetDouble(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return 0.0;
		}
	},

	alGetDoublev: function(param, pValues) {
		var val = AL.getDoubleHelper("alGetDoublev", param);
		// Silently ignore null destinations, as per the spec for global state functions
		if (val === null || !pValues) {
			return;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			{{{ makeSetValue("pValues", "0", "val", "double") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetDoublev(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetFloat: function(param) {
		var val = AL.getDoubleHelper("alGetFloat", param);
		if (val === null) {
			return 0.0;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			return val;
		default:
#if OPENAL_DEBUG
			console.error("alGetFloat(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			return 0.0;
		}
	},

	alGetFloatv: function(param, pValues) {
		var val = AL.getDoubleHelper("alGetFloatv", param);
		// Silently ignore null destinations, as per the spec for global state functions
		if (val === null || !pValues) {
			return;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			{{{ makeSetValue("pValues", "0", "val", "float") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetFloatv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetInteger: function(param) {
		var val = AL.getDoubleHelper("alGetInteger", param);
		if (val === null) {
			return 0;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			return val;
		default:
#if OPENAL_DEBUG
			console.error("alGetInteger(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return 0;
		}
	},

	alGetIntegerv: function(param, pValues) {
		var val = AL.getDoubleHelper("alGetIntegerv", param);
		// Silently ignore null destinations, as per the spec for global state functions
		if (val === null || !pValues) {
			return;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			{{{ makeSetValue("pValues", "0", "val", "i32") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetIntegerv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetBoolean: function(param) {
		var val = AL.getDoubleHelper("alGetBoolean", param);
		if (val === null) {
			return 0 /* AL_FALSE */;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			return val !== 0 ? 1 /* AL_TRUE */ : 0 /* AL_FALSE */;
		default:
#if OPENAL_DEBUG
			console.error("alGetBoolean(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return 0 /* AL_FALSE */;
		}
	},

	alGetBooleanv: function(param, pValues) {
		var val = AL.getDoubleHelper("alGetBooleanv", param);
		// Silently ignore null destinations, as per the spec for global state functions
		if (val === null || !pValues) {
			return;
		}

		switch (param) {
		case 0xC000 /* AL_DOPPLER_FACTOR */:
		case 0xC003 /* AL_SPEED_OF_SOUND */:
		case 0xD000 /* AL_DISTANCE_MODEL */:
			{{{ makeSetValue("pValues", "0", "val", "i8") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetBooleanv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alDistanceModel: function(model) {
		AL.doubleHelper("alDistanceModel", 0xD000 /* AL_DISTANCE_MODEL */, model);
	},

	alSpeedOfSound: function(value) {
		AL.doubleHelper("alSpeedOfSound", 0xC003 /* AL_SPEED_OF_SOUND */, model);
	},

	alDopplerFactor: function(value) {
		AL.doubleHelper("alDopplerFactor", 0xC000 /* AL_DOPPLER_FACTOR */, model);
	},

	// http://openal.996291.n3.nabble.com/alSpeedOfSound-or-alDopperVelocity-tp1960.html
	// alDopplerVelocity() sets a multiplier for the speed of sound.
	// It"s deprecated since it"s equivalent to directly calling
	// alSpeedOfSound() with an appropriately premultiplied value.
	alDopplerVelocity: function(value) {
		Runtime.warnOnce("alDopplerVelocity() is deprecated, and only kept for compatibility with OpenAL 1.0. Use alSpeedOfSound() instead.");
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alDopplerVelocity() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (value <= 0) { // Negative or zero values are disallowed
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}
	},

	// -------------------------------------------------------
	// -- AL Listener State
	// -------------------------------------------------------

	alGetListenerf: function(param, pValue) {
		var val = AL.getListenerHelper("alGetListenerf", param);
		if (val === null) {
			return;
		}
		if (!pValue) {
#if OPENAL_DEBUG
			console.error("alGetListenerf() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x100A /* AL_GAIN */:
			{{{ makeSetValue("pValue", "0", "val", "float") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetListenerf(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetListener3f: function(param, pValue0, pValue1, pValue2) {
		var val = AL.getListenerHelper("alGetListener3f", param);
		if (val === null) {
			return;
		}
		if (!pValue0 || !pValue1 || !pValue2) {
#if OPENAL_DEBUG
			console.error("alGetListener3f() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValue0", "0", "val[0]", "float") }}};
			{{{ makeSetValue("pValue1", "0", "val[1]", "float") }}};
			{{{ makeSetValue("pValue2", "0", "val[2]", "float") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetListener3f(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetListenerfv: function(param, pValues) {
		var val = AL.getListenerHelper("alGetListenerfv", param);
		if (val === null) {
			return;
		}
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alGetListenerfv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValues", "0", "val[0]", "float") }}};
			{{{ makeSetValue("pValues", "4", "val[1]", "float") }}};
			{{{ makeSetValue("pValues", "8", "val[2]", "float") }}};
			return;
		case 0x100F /* AL_ORIENTATION */:
			{{{ makeSetValue("pValues", "0", "val[0]", "float") }}};
			{{{ makeSetValue("pValues", "4", "val[1]", "float") }}};
			{{{ makeSetValue("pValues", "8", "val[2]", "float") }}};
			{{{ makeSetValue("pValues", "12", "val[3]", "float") }}};
			{{{ makeSetValue("pValues", "16", "val[4]", "float") }}};
			{{{ makeSetValue("pValues", "20", "val[5]", "float") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetListenerfv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetListeneri: function(param, pValue) {
		var val = AL.getListenerHelper("alGetListeneri", param);
		if (val === null) {
			return;
		}
		if (!pValue) {
#if OPENAL_DEBUG
			console.error("alGetListeneri() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

#if OPENAL_DEBUG
		console.error("alGetListeneri(): param 0x" + param.toString(16) + " has wrong signature");
#endif
		AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
	},

	alGetListener3i: function(param, pValue0, pValue1, pValue2) {
		var val = AL.getListenerHelper("alGetListener3i", param);
		if (val === null) {
			return;
		}
		if (!pValue0 || !pValue1 || !pValue2) {
#if OPENAL_DEBUG
			console.error("alGetListener3i() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValue0", "0", "val[0]", "i32") }}};
			{{{ makeSetValue("pValue1", "0", "val[1]", "i32") }}};
			{{{ makeSetValue("pValue2", "0", "val[2]", "i32") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetListener3i(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetListeneriv: function(param, pValues) {
		var val = AL.getListenerHelper("alGetListeneriv", param);
		if (val === null) {
			return;
		}
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alGetListeneriv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValues", "0", "val[0]", "i32") }}};
			{{{ makeSetValue("pValues", "4", "val[1]", "i32") }}};
			{{{ makeSetValue("pValues", "8", "val[2]", "i32") }}};
			return;
		case 0x100F /* AL_ORIENTATION */:
			{{{ makeSetValue("pValues", "0", "val[0]", "i32") }}};
			{{{ makeSetValue("pValues", "4", "val[1]", "i32") }}};
			{{{ makeSetValue("pValues", "8", "val[2]", "i32") }}};
			{{{ makeSetValue("pValues", "12", "val[3]", "i32") }}};
			{{{ makeSetValue("pValues", "16", "val[4]", "i32") }}};
			{{{ makeSetValue("pValues", "20", "val[5]", "i32") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetListeneriv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alListenerf: function(param, value) {
		switch (param) {
		case 0x100A /* AL_GAIN */:
			AL.listenerHelper("alListenerf", param, value);
			return;
		default:
			AL.listenerHelper("alListenerf", param, null);
			return;
		}
	},

	alListener3f: function(param, value0, value1, value2) {
		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			AL.listenerHelper("alListener3f", param, [value0, value1, value2]);
			return;
		default:
			AL.listenerHelper("alListener3f", param, null);
			return;
		}
	},

	alListenerfv: function(param, pValues) {
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alListenerfv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			var v0 = {{{ makeGetValue("pValues", "0", "float") }}};
			var v1 = {{{ makeGetValue("pValues", "4", "float") }}};
			var v2 = {{{ makeGetValue("pValues", "8", "float") }}};
			AL.listenerHelper("alListenerfv", param, [v0, v1, v2]);
			return;
		case 0x100F /* AL_ORIENTATION */:
			var v0 = {{{ makeGetValue("pValues", "0", "float") }}};
			var v1 = {{{ makeGetValue("pValues", "4", "float") }}};
			var v2 = {{{ makeGetValue("pValues", "8", "float") }}};
			var v3 = {{{ makeGetValue("pValues", "12", "float") }}};
			var v4 = {{{ makeGetValue("pValues", "16", "float") }}};
			var v5 = {{{ makeGetValue("pValues", "20", "float") }}};
			AL.listenerHelper("alListenerfv", param, [v0, v1, v2, v3, v4, v5]);
			return;
		default:
			AL.listenerHelper("alListenerfv", param, null);
			return;
		}
	},

	alListeneri: function(param, value) {
		AL.listenerHelper("alListeneri", param, null);
	},

	alListener3i: function(param, value0, value1, value2) {
		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			AL.listenerHelper("alListener3i", param, [value0, value1, value2]);
			return;
		default:
			AL.listenerHelper("alListener3i", param, null);
		}
	},

	alListeneriv: function(param, pValues) {
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alListeneriv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1006 /* AL_VELOCITY */:
			var v0 = {{{ makeGetValue("pValues", "0", "i32") }}};
			var v1 = {{{ makeGetValue("pValues", "4", "i32") }}};
			var v2 = {{{ makeGetValue("pValues", "8", "i32") }}};
			AL.listenerHelper("alListeneriv", param, [v0, v1, v2]);
			return;
		case 0x100F /* AL_ORIENTATION */:
			var v0 = {{{ makeGetValue("pValues", "0", "i32") }}};
			var v1 = {{{ makeGetValue("pValues", "4", "i32") }}};
			var v2 = {{{ makeGetValue("pValues", "8", "i32") }}};
			var v3 = {{{ makeGetValue("pValues", "12", "i32") }}};
			var v4 = {{{ makeGetValue("pValues", "16", "i32") }}};
			var v5 = {{{ makeGetValue("pValues", "20", "i32") }}};
			AL.listenerHelper("alListeneriv", param, [v0, v1, v2, v3, v4, v5]);
			return;
		default:
			AL.listenerHelper("alListeneriv", param, null);
		}
	},

	// -------------------------------------------------------
	// -- AL Buffer State
	// -------------------------------------------------------

	alIsBuffer: function(bufferId) {
		if (!AL.currentCtx) {
			return false;
		}
		if (bufferId > AL.buffers.length) {
			return false;
		}

		if (!AL.buffers[bufferId - 1]) {
			return false;
		} else {
			return true;
		}
	},

	alBufferData: function(bufferId, format, pData, size, freq) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alBufferData() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}

		var buf = AL.buffers[bufferId - 1];
		if (!buf) {
#if OPENAL_DEBUG
			console.error("alBufferData() called with an invalid buffer");
#endif
			return;
		}

		try {
			switch (format) {
			case 0x1100 /* AL_FORMAT_MONO8 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(1, size, freq);
				ab._bytesPerSample = 1;
				var channel0 = ab.getChannelData(0);
				for (var i = 0; i < size; ++i) channel0[i] = HEAPU8[pData++] * 0.0078125 /* 1/128 */ - 1.0;
				break;
			case 0x1101 /* AL_FORMAT_MONO16 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(1, size>>1, freq);
				ab._bytesPerSample = 2;
				var channel0 = ab.getChannelData(0);
				pData >>= 1;
				for (var i = 0; i < size>>1; ++i) channel0[i] = HEAP16[pData++] * 0.000030517578125 /* 1/32768 */;
				break;
			case 0x1102 /* AL_FORMAT_STEREO8 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(2, size>>1, freq);
				ab._bytesPerSample = 1;
				var channel0 = ab.getChannelData(0);
				var channel1 = ab.getChannelData(1);
				for (var i = 0; i < size>>1; ++i) {
					channel0[i] = HEAPU8[pData++] * 0.0078125 /* 1/128 */ - 1.0;
					channel1[i] = HEAPU8[pData++] * 0.0078125 /* 1/128 */ - 1.0;
				}
				break;
			case 0x1103 /* AL_FORMAT_STEREO16 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(2, size>>2, freq);
				ab._bytesPerSample = 2;
				var channel0 = ab.getChannelData(0);
				var channel1 = ab.getChannelData(1);
				pData >>= 1;
				for (var i = 0; i < size>>2; ++i) {
					channel0[i] = HEAP16[pData++] * 0.000030517578125 /* 1/32768 */;
					channel1[i] = HEAP16[pData++] * 0.000030517578125 /* 1/32768 */;
				}
				break;
			case 0x10010 /* AL_FORMAT_MONO_FLOAT32 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(1, size>>2, freq);
				ab._bytesPerSample = 4;
				var channel0 = ab.getChannelData(0);
				pData >>= 2;
				for (var i = 0; i < size>>2; ++i) channel0[i] = HEAPF32[pData++];
				break;
			case 0x10011 /* AL_FORMAT_STEREO_FLOAT32 */:
				var ab = AL.currentCtx.audioCtx.createBuffer(2, size>>3, freq);
				ab._bytesPerSample = 4;
				var channel0 = ab.getChannelData(0);
				var channel1 = ab.getChannelData(1);
				pData >>= 2;
				for (var i = 0; i < size>>2; ++i) {
					channel0[i] = HEAPF32[pData++];
					channel1[i] = HEAPF32[pData++];
				}
				break;
			default:
#if OPENAL_DEBUG
				console.error("alBufferData() called with invalid format " + format);
#endif
				AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
				break;
			}
			buf.audioBuf = ab;
		} catch (e) {
#if OPENAL_DEBUG
			console.error("alBufferData() upload failed with an exception " + e);
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
	},

	alGetBufferf: function(bufferId, param, pValue) {
		var val = AL.getBufferHelper("alGetBufferf", bufferId, param);
		if (val === null) {
			return;
		}
		if (!pValue) {
#if OPENAL_DEBUG
			console.error("alGetBufferf() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

#if OPENAL_DEBUG
		console.error("alGetBufferf(): param 0x" + param.toString(16) + " has wrong signature");
#endif
		AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
	},

	alGetBuffer3f: function(bufferId, param, pValue0, pValue1, pValue2) {
		var val = AL.getBufferHelper("alGetBuffer3f", bufferId, param, null);
		if (val === null) {
			return;
		}
		if (!pValue0 || !pValue1 || !pValue2) {
#if OPENAL_DEBUG
			console.error("alGetBuffer3f() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

#if OPENAL_DEBUG
		console.error("alGetBuffer3f(): param 0x" + param.toString(16) + " has wrong signature");
#endif
		AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
	},

	alGetBufferfv: function(bufferId, param, pValues) {
		var val = AL.getBufferHelper("alGetBufferfv", bufferId, param, null);
		if (val === null) {
			return;
		}
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alGetBufferfv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

#if OPENAL_DEBUG
		console.error("alGetBufferfv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
		AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
	},

	alGetBufferi: function(bufferId, param, pValue) {
		var val = AL.getBufferHelper("alGetBufferi", bufferId, param);
		if (val === null) {
			return;
		}
		if (!pValue) {
#if OPENAL_DEBUG
			console.error("alGetBufferi() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x2001 /* AL_FREQUENCY */:
		case 0x2002 /* AL_BITS */:
		case 0x2003 /* AL_CHANNELS */:
		case 0x2004 /* AL_SIZE */:
			{{{ makeSetValue("pValue", "0", "val", "i32") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetBufferi(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetBuffer3i: function(bufferId, param, pValue0, pValue1, pValue2) {
		var val = AL.getBufferHelper("alGetBuffer3i", bufferId, param);
		if (val === null) {
			return;
		}
		if (!pValue0 || !pValue1 || !pValue2) {
#if OPENAL_DEBUG
			console.error("alGetBuffer3i() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

#if OPENAL_DEBUG
		console.error("alGetBuffer3i(): param 0x" + param.toString(16) + " has wrong signature");
#endif
		AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
	},

	alGetBufferiv: function(bufferId, param, pValues) {
		var val = AL.getBufferHelper("alGetBufferiv", bufferId, param);
		if (val === null) {
			return;
		}
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alGetBufferiv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x2001 /* AL_FREQUENCY */:
		case 0x2002 /* AL_BITS */:
		case 0x2003 /* AL_CHANNELS */:
		case 0x2004 /* AL_SIZE */:
			{{{ makeSetValue("pValues", "0", "val", "i32") }}};
			break;
		default:
#if OPENAL_DEBUG
			console.error("alGetBufferiv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	// All of the remaining alBuffer* setters and getters are only of interest
	// to extensions which need them. Core OpenAL alone defines no valid
	// property for these.

	alBufferf: function(bufferId, param, value) {
		AL.bufferHelper("alBufferf", bufferId, param, null);
	},

	alBuffer3f: function(bufferId, param, value0, value1, value2) {
		AL.bufferHelper("alBuffer3f", bufferId, param, null);
	},

	alBufferfv: function(bufferId, param, pValues) {
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alBufferfv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		AL.bufferHelper("alBufferfv", bufferId, param, null);
	},

	alBufferi: function(bufferId, param, value) {
		AL.bufferHelper("alBufferi", bufferId, param, null);
	},

	alBuffer3i: function(bufferId, param, value0, value1, value2) {
		AL.bufferHelper("alBuffer3i", bufferId, param, null);
	},

	alBufferiv: function(bufferId, param, pValues) {
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alBufferiv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		AL.bufferHelper("alBufferiv", bufferId, param, null);
	},

	// -------------------------------------------------------
	// -- AL Source State
	// -------------------------------------------------------

	alIsSource: function(sourceId) {
		if (!AL.currentCtx) {
			return false;
		}

		if (!AL.currentCtx.sources[sourceId - 1]) {
			return false;
		} else {
			return true;
		}
	},

	alSourceQueueBuffers: function(sourceId, count, pBufferIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceQueueBuffers() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceQueueBuffers() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		if (src.type === 0x1028 /* AL_STATIC */) {
#if OPENAL_DEBUG
			console.error("alSourceQueueBuffers() called while a static buffer is bound");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		for (var i = 0; i < count; ++i) {
			var bufId = {{{ makeGetValue("pBufferIds", "i*4", "i32") }}};
			var buf = AL.buffers[bufId - 1];
			if (!buf) {
#if OPENAL_DEBUG
				console.error("alSourceQueueBuffers() called with an invalid buffer");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}

			// All buffers in a queue must have the same format
			var templateBuf = src.bufQueue[0];
			if (templateBuf && (
				buf.audioBuf.sampleRate !== templateBuf.audioBuf.sampleRate
				|| buf.audioBuf._bytesPerSample !== templateBuf.audioBuf._bytesPerSample
				|| buf.audioBuf.numberOfChannels !== templateBuf.audioBuf.numberOfChannels)
			) {
#if OPENAL_DEBUG
				console.error("alSourceQueueBuffers() called with a buffer of different format");
#endif
				AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			}
		}

		src.type = 0x1029 /* AL_STREAMING */;
		for (var i = 0; i < count; ++i) {
			var bufId = {{{ makeGetValue("pBufferIds", "i*4", "i32") }}};
			var buf = AL.buffers[bufId - 1];
			buf.refCount++;
			src.bufQueue.push(buf);
		}

		// if the source is looping, cancel the schedule so we can reschedule the loop order
		if (src.loop) {
			AL.cancelPendingSourceAudio(src);
		}

		AL.initSourcePanner(src);
		AL.scheduleSourceAudio(src);
	},

	alSourceUnqueueBuffers: function(sourceId, count, pBufferIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceUnqueueBuffers() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceUnqueueBuffers() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}

		if (count > src.bufsProcessed) {
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		for (var i = 0; i < count; i++) {
			var buf = src.bufQueue.shift();
			buf.refCount--;
			// Write the buffers index out to the return list.
			{{{ makeSetValue("pBufferIds", "i*4", "buf.id", "i32") }}};
			src.bufsProcessed--;
		}

		AL.initSourcePanner(src);
		AL.scheduleSourceAudio(src);
	},

	alSourcePlay: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePlay() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourcePlay() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		AL.setSourceState(src, 0x1012 /* AL_PLAYING */);
	},

	alSourcePlayv: function(count, pSourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePlayv() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (!pSourceIds) {
#if OPENAL_DEBUG
			console.error("alSourcePlayv() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("pSourceIds", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourcePlayv() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("pSourceIds", "i*4", "i32") }}}, 0x1012 /* AL_PLAYING */);
		}
	},

	alSourceStop: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceStop() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceStop() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		AL.setSourceState(src, 0x1014 /* AL_STOPPED */);
	},

	alSourceStopv: function(count, pSourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceStopv() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (!pSourceIds) {
#if OPENAL_DEBUG
			console.error("alSourceStopv() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("pSourceIds", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourceStopv() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("pSourceIds", "i*4", "i32") }}}, 0x1014 /* AL_STOPPED */);
		}
	},

	alSourceRewind: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceRewind() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourceRewind() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		// Stop the source first to clear the source queue
		AL.setSourceState(src, 0x1014 /* AL_STOPPED */);
		// Now set the state of AL_INITIAL according to the specification
		AL.setSourceState(src, 0x1011 /* AL_INITIAL */);
	},

	alSourceRewindv: function(count, pSourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourceRewindv() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (!pSourceIds) {
#if OPENAL_DEBUG
			console.error("alSourceRewindv() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("pSourceIds", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourceRewindv() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("pSourceIds", "i*4", "i32") }}}, 0x1011 /* AL_INITIAL */);
		}
	},

	alSourcePause: function(sourceId) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePause() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		var src = AL.currentCtx.sources[sourceId - 1];
		if (!src) {
#if OPENAL_DEBUG
			console.error("alSourcePause() called with an invalid source");
#endif
			AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
			return;
		}
		AL.setSourceState(src, 0x1013 /* AL_PAUSED */);
	},

	alSourcePausev: function(count, pSourceIds) {
		if (!AL.currentCtx) {
#if OPENAL_DEBUG
			console.error("alSourcePausev() called without a valid context");
#endif
			AL.currentCtx.err = 0xA004 /* AL_INVALID_OPERATION */;
			return;
		}
		if (!pSourceIds) {
#if OPENAL_DEBUG
			console.error("alSourcePausev() called with null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
		}
		for (var i = 0; i < count; ++i) {
			if (!AL.currentCtx.sources[{{{ makeGetValue("pSourceIds", "i*4", "i32") }}} - 1]) {
#if OPENAL_DEBUG
				console.error("alSourcePausev() called with an invalid source");
#endif
				AL.currentCtx.err = 0xA001 /* AL_INVALID_NAME */;
				return;
			}
		}

		for (var i = 0; i < count; ++i) {
			AL.setSourceState({{{ makeGetValue("pSourceIds", "i*4", "i32") }}}, 0x1013 /* AL_PAUSED */);
		}
	},

	alGetSourcef: function(sourceId, param, pValue) {
		var val = AL.getSourceHelper("alGetSourcef", sourceId, param);
		if (val === null) {
			return;
		}
		if (!pValue) {
#if OPENAL_DEBUG
			console.error("alGetSourcef() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1003 /* AL_PITCH */:
		case 0x100A /* AL_GAIN */:
		case 0x100D /* AL_MIN_GAIN */:
		case 0x100E /* AL_MAX_GAIN */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1022 /* AL_CONE_OUTER_GAIN */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
			{{{ makeSetValue("pValue", "0", "val", "float") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetSourcef(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetSource3f: function(source, param, pValue0, pValue1, pValue2) {
		var val = AL.getSourceHelper("alGetSource3f", sourceId, param);
		if (val === null) {
			return;
		}
		if (!pValue0 || !pValue1 || !pValue2) {
#if OPENAL_DEBUG
			console.error("alGetSource3f() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValue0", "0", "val[0]", "float") }}};
			{{{ makeSetValue("pValue1", "0", "val[1]", "float") }}};
			{{{ makeSetValue("pValue2", "0", "val[2]", "float") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetSource3f(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetSourcefv: function(sourceId, param, pValues) {
		var val = AL.getSourceHelper("alGetSourcefv", sourceId, param);
		if (val === null) {
			return;
		}
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alGetSourcefv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1003 /* AL_PITCH */:
		case 0x100A /* AL_GAIN */:
		case 0x100D /* AL_MIN_GAIN */:
		case 0x100E /* AL_MAX_GAIN */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1022 /* AL_CONE_OUTER_GAIN */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
			{{{ makeSetValue("pValues", "0", "val[0]", "float") }}};
			return;
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValues", "0", "val[0]", "float") }}};
			{{{ makeSetValue("pValues", "4", "val[1]", "float") }}};
			{{{ makeSetValue("pValues", "8", "val[2]", "float") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetSourcefv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetSourcei: function(sourceId, param, pValue) {
		var val = AL.getSourceHelper("alGetSourcei", sourceId, param);
		if (val === null) {
			return;
		}
		if (!pValue) {
#if OPENAL_DEBUG
			console.error("alGetSourcei() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x202 /* AL_SOURCE_RELATIVE */:
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1007 /* AL_LOOPING */:
		case 0x1009 /* AL_BUFFER */:
		case 0x1010 /* AL_SOURCE_STATE */:
		case 0x1015 /* AL_BUFFERS_QUEUED */:
		case 0x1016 /* AL_BUFFERS_PROCESSED */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
		case 0x1027 /* AL_SOURCE_TYPE */:
			{{{ makeSetValue("pValue", "0", "val", "i32") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetSourcei(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetSource3i: function(source, param, pValue0, pValue1, pValue2) {
		var val = AL.getSourceHelper("alGetSource3i", sourceId, param);
		if (val === null) {
			return;
		}
		if (!pValue0 || !pValue1 || !pValue2) {
#if OPENAL_DEBUG
			console.error("alGetSource3i() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValue0", "0", "val[0]", "i32") }}};
			{{{ makeSetValue("pValue1", "0", "val[1]", "i32") }}};
			{{{ makeSetValue("pValue2", "0", "val[2]", "i32") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetSource3i(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alGetSourceiv: function(sourceId, param, pValues) {
		var val = AL.getSourceHelper("alGetSourceiv", sourceId, param);
		if (val === null) {
			return;
		}
		if (!pValues) {
#if OPENAL_DEBUG
			console.error("alGetSourceiv() called with a null pointer");
#endif
			AL.currentCtx.err = 0xA003 /* AL_INVALID_VALUE */;
			return;
		}

		switch (param) {
		case 0x202 /* AL_SOURCE_RELATIVE */:
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1007 /* AL_LOOPING */:
		case 0x1009 /* AL_BUFFER */:
		case 0x1010 /* AL_SOURCE_STATE */:
		case 0x1015 /* AL_BUFFERS_QUEUED */:
		case 0x1016 /* AL_BUFFERS_PROCESSED */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
		case 0x1027 /* AL_SOURCE_TYPE */:
			{{{ makeSetValue("pValues", "0", "val", "i32") }}};
			return;
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			{{{ makeSetValue("pValues", "0", "val[0]", "i32") }}};
			{{{ makeSetValue("pValues", "4", "val[1]", "i32") }}};
			{{{ makeSetValue("pValues", "8", "val[2]", "i32") }}};
			return;
		default:
#if OPENAL_DEBUG
			console.error("alGetSourceiv(): param 0x" + param.toString(16) + " has wrong signature");
#endif
			AL.currentCtx.err = 0xA002 /* AL_INVALID_ENUM */;
			return;
		}
	},

	alSourcef: function(sourceId, param, value) {
		switch (param) {
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1003 /* AL_PITCH */:
		case 0x100A /* AL_GAIN */:
		case 0x100D /* AL_MIN_GAIN */:
		case 0x100E /* AL_MAX_GAIN */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1022 /* AL_CONE_OUTER_GAIN */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
			AL.sourceHelper("alSourcef", sourceId, param, value);
			return;
		default:
			AL.sourceHelper("alSourcef", sourceId, param, null);
			return;
		}
	},

	alSource3f: function(sourceId, param, value0, value1, value2) {
		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			AL.sourceHelper("alSource3f", sourceId, param, [value0, value1, value2]);
			return;
		default:
			AL.sourceHelper("alSource3f", sourceId, param, null);
			return;
		}
	},

	alSourcefv: function(sourceId, param, pValues) {
		switch (param) {
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1003 /* AL_PITCH */:
		case 0x100A /* AL_GAIN */:
		case 0x100D /* AL_MIN_GAIN */:
		case 0x100E /* AL_MAX_GAIN */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1022 /* AL_CONE_OUTER_GAIN */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
			var val = {{{ makeGetValue("pValues", "0", "float") }}};
			AL.sourceHelper("alSourcefv", sourceId, param, val);
			return;
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			var v0 = {{{ makeGetValue("pValues", "0", "float") }}};
			var v1 = {{{ makeGetValue("pValues", "4", "float") }}};
			var v2 = {{{ makeGetValue("pValues", "8", "float") }}};
			AL.sourceHelper("alSourcefv", sourceId, param, [value0, value1, value2]);
			return;
		default:
			AL.sourceHelper("alSourcefv", sourceId, param, null);
			return;
		}
	},

	alSourcei: function(sourceId, param, value) {
		switch (param) {
		case 0x202 /* AL_SOURCE_RELATIVE */:
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1007 /* AL_LOOPING */:
		case 0x1009 /* AL_BUFFER */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
			AL.sourceHelper("alSourcei", sourceId, param, value);
			return;
		default:
			AL.sourceHelper("alSourcei", sourceId, param, null);
			return;
		}
	},

	alSource3i: function(sourceId, param, value0, value1, value2) {
		switch (param) {
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			AL.sourceHelper("alSource3i", sourceId, param, [value0, value1, value2]);
			return;
		default:
			AL.sourceHelper("alSource3i", sourceId, param, null);
			return;
		}
	},

	alSourceiv: function(source, param, pValues) {
		switch (param) {
		case 0x202 /* AL_SOURCE_RELATIVE */:
		case 0x1001 /* AL_CONE_INNER_ANGLE */:
		case 0x1002 /* AL_CONE_OUTER_ANGLE */:
		case 0x1007 /* AL_LOOPING */:
		case 0x1009 /* AL_BUFFER */:
		case 0x1020 /* AL_REFERENCE_DISTANCE */:
		case 0x1021 /* AL_ROLLOFF_FACTOR */:
		case 0x1023 /* AL_MAX_DISTANCE */:
		case 0x1024 /* AL_SEC_OFFSET */:
		case 0x1025 /* AL_SAMPLE_OFFSET */:
		case 0x1026 /* AL_BYTE_OFFSET */:
			var val = {{{ makeGetValue("pValues", "0", "i32") }}};
			AL.sourceHelper("alSourceiv", sourceId, param, val);
			return;
		case 0x1004 /* AL_POSITION */:
		case 0x1005 /* AL_DIRECTION */:
		case 0x1006 /* AL_VELOCITY */:
			var v0 = {{{ makeGetValue("pValues", "0", "i32") }}};
			var v1 = {{{ makeGetValue("pValues", "4", "i32") }}};
			var v2 = {{{ makeGetValue("pValues", "8", "i32") }}};
			AL.sourceHelper("alSourceiv", sourceId, param, [value0, value1, value2]);
			return;
		default:
			AL.sourceHelper("alSourceiv", sourceId, param, null);
			return;
		}
	}
};

autoAddDeps(LibraryOpenAL, "$AL");
mergeInto(LibraryManager.library, LibraryOpenAL);

