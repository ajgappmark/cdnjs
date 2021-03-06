(function($window, L, d3, ClipperLib) {

    "use strict";

    /**
     * @method freeDraw
     * @param options {Object}
     * @return {window.L.FreeDraw}
     */
    L.freeDraw = function freeDraw(options) {
        return new L.FreeDraw(options);
    };

    L.FreeDraw = L.FeatureGroup.extend({

        /**
         * @property map
         * @type {L.Map|null}
         */
        map: null,

        /**
         * @property svg
         * @type {Object}
         */
        svg: {},

        /**
         * @property element
         * @type {Object}
         */
        element: {},

        /**
         * Determines whether the user is currently creating a polygon.
         *
         * @property creating
         * @type {Boolean}
         */
        creating: false,

        /**
         * Responsible for holding the line function that is required by D3 to draw the line based
         * on the user's cursor position.
         *
         * @property lineFunction
         * @type {Function}
         */
        lineFunction: function () {},

        /**
         * Responsible for holding an array of latitudinal and longitudinal points for generating
         * the polygon.
         *
         * @property latLngs
         * @type {Array}
         */
        latLngs: [],

        /**
         * @property options
         * @type {Object}
         */
        options: {},

        /**
         * @property lastNotification
         * @type {String}
         */
        lastNotification: '',

        /**
         * @property markers
         * @type {L.LayerGroup|null}
         */
        markerLayer: L.layerGroup(),

        /**
         * @property hull
         * @type {Object}
         */
        hull: {},

        /**
         * @property polygons
         * @type {Array}
         */
        polygons: [],

        /**
         * @property edges
         * @type {Array}
         */
        edges: [],

        /**
         * @property mode
         * @type {Number}
         */
        mode: 1,

        /**
         * @property polygonCount
         * @type {Number}
         */
        polygonCount: 0,

        /**
         * Responsible for holding the coordinates of the user's last cursor position for drawing
         * the D3 polygon tracing the user's cursor.
         *
         * @property fromPoint
         * @type {Object}
         */
        fromPoint: { x: 0, y: 0 },

        /**
         * @property movingEdge
         * @type {L.polygon|null}
         */
        movingEdge: null,

        /**
         * Responsible for knowing whether a boundary update should be propagated once the user exits
         * the editing mode.
         *
         * @property boundaryUpdateRequired
         * @type {Boolean}
         */
        boundaryUpdateRequired: false,

        /**
         * @property silenced
         * @type {Boolean}
         */
        silenced: false,

        /**
         * @method initialize
         * @param options {Object}
         * @return {void}
         */
        initialize: function initialize(options) {

            if (typeof d3 === 'undefined') {

                // Ensure D3 has been included.
                L.FreeDraw.Throw('D3 is a required library', 'http://d3js.org/');

            }

            if (typeof ClipperLib === 'undefined') {

                // Ensure JSClipper has been included.
                L.FreeDraw.Throw('JSClipper is a required library', 'http://sourceforge.net/p/jsclipper/wiki/Home%206/');

            }

            // Reset all of the properties.
            this.fromPoint = { x: 0, y: 0 };
            this.polygons  = [];
            this.edges     = [];
            this.hull      = {};
            this.latLngs   = [];

            options = options || {};

            this.options = new L.FreeDraw.Options();
            this.hull    = new L.FreeDraw.Hull();
            this.element = options.element || null;

            this.setMode(options.mode || this.mode);
            this.options.setPathClipperPadding(100);

        },

        /**
         * @method recreateEdges
         * @param polygon {Object}
         * @return {Number|Boolean}
         */
        recreateEdges: function recreateEdges(polygon) {

            // Remove all of the current edges associated with the polygon.
            this.edges = this.edges.filter(function filter(edge) {

                if (edge._freedraw.polygon !== polygon) {
                    return true;
                }

                // Physically remove the edge from the DOM.
                this.map.removeLayer(edge);

            }.bind(this));

            // We can then re-attach the edges based on the current zoom level.
            return this.createEdges(polygon);

        },

        /**
         * @method resurrectOrphans
         * @return {void}
         */
        resurrectOrphans: function resurrectOrphans() {

            /**
             * @method recreate
             * @param polygon {Object}
             * @return {void}
             */
            var recreate = function recreate(polygon) {

                setTimeout(function() {

                    this.silently(function silently() {

                        // Reattach the polygon's edges.
                        this.recreateEdges(polygon);

                    }.bind(this));

                }.bind(this));

            };

            var polygons = this.getPolygons(true);

            polygons.forEach(function forEach(polygon) {

                if (polygon._parts[0]) {

                    // If the polygon is currently visible then we'll re-attach its edges for the current
                    // zoom level.
                    recreate.call(this, polygon);

                }

            }.bind(this));

            setTimeout(function setTimeout() {

                // Notify everybody of the update if we're using the edges to read the lat/longs.
                this.notifyBoundaries();

            }.bind(this));

        },

        /**
         * @method onAdd
         * @param map {L.Map}
         * @return {void}
         */
        onAdd: function onAdd(map) {

            map.on('zoomend', function onZoomEnd() {

                setTimeout(this.resurrectOrphans.bind(this));

            }.bind(this));

            // Lazily hook up the options and hull objects.
            this.map  = map;
            this.mode = this.mode || L.FreeDraw.MODES.VIEW;

            if (!this.element) {

                // Define the element D3 will bind to if the user hasn't specified a custom node.
                this.element = map._container;

            }

            // Define the line function for drawing the polygon from the user's mouse pointer.
            this.lineFunction = d3.svg.line()
                                  .x(function pointX(d) { return d.x; })
                                  .y(function pointY(d) { return d.y; })
                                  .interpolate('linear');

            // Create a new instance of the D3 free-hand tracer.
            this.createD3();

            // Attach all of the events.
            this._attachMouseDown();
            this._attachMouseMove();
            this._attachMouseUpLeave();

            // Set the default mode.
            this.setMode(this.mode);

        },

        /**
         * @method onRemove
         * @return {void}
         */
        onRemove: function onRemove() {
            this._clearPolygons();
        },

        /**
         * Responsible for polygon mutation without emitting the markers event.
         *
         * @method silently
         * @param callbackFn {Function}
         * @return {void}
         */
        silently: function silently(callbackFn) {
            this.silenced = true;
            callbackFn.apply(this);
            this.silenced = false;
        },

        /**
         * @method cancelAction
         * @return {void}
         */
        cancelAction: function cancelAction() {

            this.creating   = false;
            this.movingEdge = null;

            // Begin to create a brand-new polygon.
            this.destroyD3().createD3();

        },

        /**
         * @method setMode
         * @param mode {Number}
         * @return {void}
         */
        setMode: function setMode(mode) {

            // Prevent the mode from ever being defined as zero.
            mode = (mode === 0) ? L.FreeDraw.MODES.VIEW : mode;

            var isCreate = !!(mode & L.FreeDraw.MODES.CREATE),
                method   = !isCreate ? 'enable' : 'disable';

            // Set the current mode and emit the event.
            this.mode = mode;
            this.fire('mode', { mode: mode });

            if (!this.map) {
                return;
            }

            if (this.boundaryUpdateRequired && !(this.mode & L.FreeDraw.MODES.EDIT)) {

                // Share the boundaries if there's an update available and the user is changing the mode
                // to anything else but the edit mode again.
                this.notifyBoundaries();
                this.boundaryUpdateRequired = false;

            }

            // Update the permissions for what the user can do on the map.
            this.map.dragging[method]();
            this.map.touchZoom[method]();
            this.map.doubleClickZoom[method]();
            this.map.scrollWheelZoom[method]();

            /**
             * Responsible for applying the necessary classes to the map based on the
             * current active modes.
             *
             * @method defineClasses
             * @return {void}
             */
            (function defineClasses(modes, map, addClass, removeClass) {

                removeClass(map, 'mode-create');
                removeClass(map, 'mode-edit');
                removeClass(map, 'mode-delete');
                removeClass(map, 'mode-view');

                if (mode & modes.CREATE) {
                    addClass(map, 'mode-create');
                }

                if (mode & modes.EDIT) {
                    addClass(map, 'mode-edit');
                }

                if (mode & modes.DELETE) {
                    addClass(map, 'mode-delete');
                }

                if (mode & modes.VIEW) {
                    addClass(map, 'mode-view');
                }

                if (mode & modes.APPEND) {
                    addClass(map, 'mode-append');
                }

            }(L.FreeDraw.MODES, this.map._container, L.DomUtil.addClass, L.DomUtil.removeClass));

        },

        /**
         * @method unsetMode
         * @param mode {Number}
         * @return {void}
         */
        unsetMode: function unsetMode(mode) {
            this.setMode(this.mode ^ mode);
        },

        /**
         * @method createD3
         * @return {void}
         */
        createD3: function createD3() {

            this.svg = d3.select(this.options.element || this.element).append('svg')
                         .attr('class', this.options.svgClassName)
                         .attr('width', 200).attr('height', 200);

        },

        /**
         * @method destroyD3
         * @return {L.FreeDraw}
         * @chainable
         */
        destroyD3: function destroyD3() {
            this.svg.remove();
            this.svg = {};
            return this;
        },

        /**
         * @method latLngsToClipperPoints
         * @param latLngs {L.LatLng[]}
         * @return {Object}
         */
        latLngsToClipperPoints: function latLngsToClipperPoints(latLngs) {

            return latLngs.map(function forEach(latLng) {

                var point = this.map.latLngToLayerPoint(latLng);
                return { X: point.x, Y: point.y };

            }.bind(this));

        },

        /**
         * @method clipperPolygonsToLatLngs
         * @param polygons {Array}
         * @return {Array}
         */
        clipperPolygonsToLatLngs: function clipperPolygonsToLatLngs(polygons) {

            var latLngs = [];

            polygons.forEach(function forEach(polygon) {

                polygon.forEach(function polygons(point) {

                    point = L.point(point.X, point.Y);
                    var latLng = this.map.layerPointToLatLng(point);
                    latLngs.push(latLng);

                }.bind(this));

            }.bind(this));

            return latLngs;

        },

        /**
         * @method uniqueLatLngs
         * @param latLngs {L.LatLng[]}
         * @return {L.LatLng[]}
         */
        uniqueLatLngs: function uniqueLatLngs(latLngs) {

            var previousLatLngs = [],
                uniqueValues    = [];

            latLngs.forEach(function forEach(latLng) {

                var model = JSON.stringify(latLng);

                if (previousLatLngs.indexOf(model) !== -1) {
                    return;
                }

                previousLatLngs.push(model);
                uniqueValues.push(latLng);

            });

            return uniqueValues;

        },

        /**
         * @method handlePolygonClick
         * @param polygon {L.Polygon}
         * @param event {Object}
         * @return {void}
         */
        handlePolygonClick: function handlePolygonClick(polygon, event) {

            var latLngs        = [],
                newPoint       = this.map.mouseEventToContainerPoint(event.originalEvent),
                lowestDistance = Infinity,
                startPoint     = new L.Point(),
                endPoint       = new L.Point(),
                parts          = [];

            polygon._latlngs.forEach(function forEach(latLng) {

                // Push each part into the array, because relying on the polygon's "_parts" array
                // isn't safe since they are removed when parts of the polygon aren't visible.
                parts.push(this.map.latLngToContainerPoint(latLng));

            }.bind(this));

            parts.forEach(function forEach(point, index) {

                var firstPoint  = point,
                    secondPoint = parts[index + 1] || parts[0],
                    distance    = L.LineUtil.pointToSegmentDistance(newPoint, firstPoint, secondPoint);

                if (distance < lowestDistance) {

                    // We discovered a distance that possibly should contain the new point!
                    lowestDistance = distance;
                    startPoint     = firstPoint;
                    endPoint       = secondPoint;

                }

            }.bind(this));

            parts.forEach(function forEach(point, index) {

                var nextPoint = parts[index + 1] || parts[0];

                if (point === startPoint && nextPoint === endPoint) {

                    latLngs.push(this.map.containerPointToLatLng(point));
                    latLngs.push(this.map.containerPointToLatLng(newPoint));
                    return;

                }

                latLngs.push(this.map.containerPointToLatLng(point));

            }.bind(this));

            /**
             * @constant INNER_DISTANCE
             * @type {Number}
             */
            var INNER_DISTANCE = this.options.elbowDistance;

            /**
             * @method updatePolygon
             * @return {void}
             */
            var updatePolygon = function updatePolygon() {

                if (!(this.mode & L.FreeDraw.MODES.APPEND)) {

                    // User hasn't enabled the append mode.
                    return;

                }

                // Redraw the polygon based on the newly added lat/long boundaries.
                polygon.setLatLngs(latLngs);

                // Recreate the edges for the polygon.
                this.destroyEdges(polygon);
                this.createEdges(polygon);

            }.bind(this);

            // If the user hasn't enabled delete mode but has the append mode active, then we'll
            // assume they're always wanting to add an edge.
            if (this.mode & L.FreeDraw.MODES.APPEND && !(this.mode & L.FreeDraw.MODES.DELETE)) {

                // Mode has been set to only add new elbows when the user clicks the polygon close
                // to the boundaries as defined by the `setMaximumDistanceForElbow` method.
                if (this.options.onlyInDistance && lowestDistance > INNER_DISTANCE) {
                    return;
                }

                updatePolygon();
                return;

            }

            // If the inverse of the aforementioned is true then we'll always delete the polygon.
            if (this.mode & L.FreeDraw.MODES.DELETE && !(this.mode & L.FreeDraw.MODES.APPEND)) {
                this.destroyPolygon(polygon);
                return;
            }

            // Otherwise we'll use some logic to detect whether we should delete or add a new elbow.
            if (lowestDistance > INNER_DISTANCE && this.mode & L.FreeDraw.MODES.DELETE) {

                // Delete the polygon!
                this.destroyPolygon(polygon);
                return;

            }

            // Otherwise create a new elbow.
            updatePolygon();

        },

        /**
         * @method createPolygon
         * @param latLngs {L.LatLng[]}
         * @param [forceCreation=false] {Boolean}
         * @return {L.Polygon|Boolean}
         */
        createPolygon: function createPolygon(latLngs, forceCreation) {

            // Begin to create a brand-new polygon.
            this.destroyD3().createD3();

            if (this.options.simplifyPolygon) {

                latLngs = function simplifyPolygons() {

                    var points   = ClipperLib.Clipper.CleanPolygon(this.latLngsToClipperPoints(latLngs), 1.1),
                        polygons = ClipperLib.Clipper.SimplifyPolygon(points, ClipperLib.PolyFillType.pftNonZero);

                    return this.clipperPolygonsToLatLngs(polygons);

                }.apply(this);

            }

            if (latLngs.length <= 3) {

                if (!forceCreation) {
                    return false;
                }

            }

            var polygon = new L.Polygon(latLngs, {
                color: '#D7217E',
                weight: 0,
                fill: true,
                fillColor: '#D7217E',
                fillOpacity: 0.75,
                smoothFactor: this.options.smoothFactor
            });

            // Handle the click event on a polygon.
            polygon.on('click', function onClick(event) {
                this.handlePolygonClick(polygon, event);
            }.bind(this));

            // Add the polyline to the map, and then find the edges of the polygon.
            polygon.addTo(this.map);
            this.polygons.push(polygon);

            // Attach all of the edges to the polygon.
            this.createEdges(polygon);

            /**
             * Responsible for preventing the re-rendering of the polygon.
             *
             * @return {void}
             */
            (function clobberLatLngs() {

                if (this.silenced || !polygon._parts[0]) {
                    return;
                }

                polygon._latlngs = [];

                polygon._parts[0].forEach(function forEach(edge) {

                    // Iterate over all of the parts to update the latLngs to clobber the redrawing upon zooming.
                    polygon._latlngs.push(this.map.layerPointToLatLng(edge));

                }.bind(this));

            }.bind(this))();

            if (this.options.attemptMerge && !this.silenced) {

                // Merge the polygons if the developer wants to, which at the moment is very experimental!
                this.mergePolygons();

            }

            if (!this.silenced) {
                this.notifyBoundaries();
            }

            return polygon;

        },

        /**
         * @method getPolygons
         * @param [all=false] {Boolean}
         * @return {Array}
         */
        getPolygons: function getPolygons(all) {

            var polygons = [];

            if (all) {

                if (!this.map) {
                    return [];
                }

                /**
                 * Used to identify a node that is a <g> element.
                 *
                 * @constant GROUP_TAG
                 * @type {String}
                 */
                var GROUP_TAG = 'G';

                for (var layerIndex in this.map._layers) {

                    if (this.map._layers.hasOwnProperty(layerIndex)) {

                        var polygon = this.map._layers[layerIndex];

                        // Ensure we're dealing with a <g> node (...an SVG group element).
                        if (polygon._container && polygon._container.tagName.toUpperCase() === GROUP_TAG) {
                            polygons.push(polygon);
                        }

                    }

                }

            } else {

                this.edges.forEach(function forEach(edge) {

                    if (polygons.indexOf(edge._freedraw.polygon) === -1) {
                        polygons.push(edge._freedraw.polygon);
                    }

                }.bind(this));

            }

            return polygons;

        },

        /**
         * @method mergePolygons
         * @return {void}
         */
        mergePolygons: function mergePolygons() {

            /**
             * @method mergePass
             * @return {void}
             */
            var mergePass = function mergePass() {

                var allPolygons = this.getPolygons(),
                    allPoints   = [];

                allPolygons.forEach(function forEach(polygon) {
                    allPoints.push(this.latLngsToClipperPoints(polygon._latlngs));
                }.bind(this));

                var polygons = ClipperLib.Clipper.SimplifyPolygons(allPoints, ClipperLib.PolyFillType.pftNonZero);

                this.silently(function silently() {

                    this._clearPolygons();

                    polygons.forEach(function forEach(polygon) {

                        var latLngs = [];

                        polygon.forEach(function forEach(point) {

                            point = L.point(point.X, point.Y);
                            latLngs.push(this.map.layerPointToLatLng(point));

                        }.bind(this));

                        // Create the polygon!
                        this.createPolygon(latLngs, true);

                    }.bind(this));

                });

            }.bind(this);

            // Perform two merge passes to simplify the polygons.
            mergePass(); mergePass();

            // Trim polygon edges after being modified.
            this.getPolygons(true).forEach(function forEach(polygon) {
                this.trimPolygonEdges(polygon);
            }.bind(this));

        },

        /**
         * @method destroyPolygon
         * @param polygon {Object}
         * @return {void}
         */
        destroyPolygon: function destroyPolygon(polygon) {

            this.map.removeLayer(polygon);

            // Remove from the polygons array.
            var index = this.polygons.indexOf(polygon);
            this.polygons.splice(index, 1);

            this.destroyEdges(polygon);

            if (!this.silenced) {
                this.notifyBoundaries();
            }

            if (this.options.deleteExitMode && !this.silenced) {

                // Automatically exit the user from the deletion mode.
                this.setMode(this.mode ^ L.FreeDraw.MODES.DELETE);

            }

        },

        /**
         * @method destroyEdges
         * @param polygon {Object}
         * @return {void}
         */
        destroyEdges: function destroyEdges(polygon) {

            // ...And then remove all of its related edges to prevent memory leaks.
            this.edges = this.edges.filter(function filter(edge) {

                if (edge._freedraw.polygon !== polygon) {
                    return true;
                }

                // Physically remove the edge from the DOM.
                this.map.removeLayer(edge);

            }.bind(this));

        },

        /**
         * @method clearPolygons
         * @return {void}
         */
        clearPolygons: function clearPolygons() {
            this.silently(this._clearPolygons);
            this.notifyBoundaries();
        },

        /**
         * @method _clearPolygons
         * @return {void}
         * @private
         */
        _clearPolygons: function _clearPolygons() {

            this.getPolygons().forEach(function forEach(polygon) {

                // Iteratively remove each polygon in the DOM.
                this.destroyPolygon(polygon);

            }.bind(this));

            if (!this.silenced) {
                this.notifyBoundaries();
            }

        },

        /**
         * @method notifyBoundaries
         * @return {void}
         */
        notifyBoundaries: function notifyBoundaries() {

            var latLngs = [];

            this.getPolygons(true).forEach(function forEach(polygon) {

                // Ensure the polygon is visible.
                latLngs.push(polygon._latlngs);

            }.bind(this));

            // Ensure the polygon is closed for the geospatial query.
            (function createClosedPolygon() {

                latLngs.forEach(function forEach(latLngGroup) {

                    // Determine if the latitude/longitude values differ for the first and last
                    // lat/long objects.
                    var lastIndex  = latLngGroup.length - 1,
                        latDiffers = latLngGroup[0].lat !== latLngGroup[lastIndex].lat,
                        lngDiffers = latLngGroup[0].lng !== latLngGroup[lastIndex].lng;

                    if (latDiffers && lngDiffers) {

                        // It's not currently a closed polygon for the query, so we'll create the closed
                        // polygon for the geospatial query.
                        latLngGroup.push(latLngGroup[0]);

                    }

                });

            }.bind(this))();

            // Update the polygon count variable.
            this.polygonCount = latLngs.length;

            // Ensure the last shared notification differs from the current.
            var notificationFingerprint = JSON.stringify(latLngs);
            if (this.lastNotification === notificationFingerprint) {
                return;
            }

            // Save the notification for the next time.
            this.lastNotification = notificationFingerprint;

            // Invoke the user passed method for specifying latitude/longitudes.
            this.fire('markers', { latLngs: latLngs });

        },

        /**
         * @method setMarkers
         * @param markers {L.Marker[]}
         * @param divIcon {L.DivIcon}
         * @return {void}
         */
        setMarkers: function setMarkers(markers, divIcon) {

            if (typeof divIcon !== 'undefined' && !(divIcon instanceof L.DivIcon)) {

                // Ensure if the user has passed a second argument that it is a valid DIV icon.
                L.FreeDraw.Throw('Second argument must be an instance of L.DivIcon');

            }

            // Reset the markers collection.
            this.map.removeLayer(this.markerLayer);
            this.markerLayer = L.layerGroup();
            this.markerLayer.addTo(this.map);

            if (!markers || markers.length === 0) {
                return;
            }

            var options = divIcon ? { icon: divIcon } : {};

            // Iterate over each marker to plot it on the map.
            for (var addIndex = 0, addLength = markers.length; addIndex < addLength; addIndex++) {

                if (!(markers[addIndex] instanceof L.LatLng)) {
                    L.FreeDraw.Throw('Supplied markers must be instances of L.LatLng');
                }

                // Add the marker using the custom DIV icon if it has been specified.
                var marker = L.marker(markers[addIndex], options);
                this.markerLayer.addLayer(marker);

            }

        },

        /**
         * @method createEdges
         * @param polygon {L.polygon}
         * @return {Number|Boolean}
         */
        createEdges: function createEdges(polygon) {

            /**
             * Responsible for getting the parts based on the original lat/longs.
             *
             * @method originalLatLngs
             * @param polygon {Object}
             * @return {Array}
             */
            var originalLatLngs = function originalLatLngs(polygon) {

                if (!polygon._parts[0]) {

                    // We don't care for polygons that are not in the viewport.
                    return [];

                }

                return polygon._latlngs.map(function map(latLng) {
                    return this.map.latLngToLayerPoint(latLng);
                }.bind(this));

            }.bind(this);

            var parts     = this.uniqueLatLngs(originalLatLngs(polygon)),
                edgeCount = 0;

            if (!parts) {
                return false;
            }

            parts.forEach(function forEach(point) {

                // Leaflet creates elbows in the polygon, which we need to utilise to add the
                // points for modifying its shape.
                var edge   = L.divIcon({ className: this.options.iconClassName }),
                    latLng = this.map.layerPointToLatLng(point);

                edge = L.marker(latLng, { icon: edge }).addTo(this.map);

                // Setup the freedraw object with the meta data.
                edge._freedraw = {
                    polygon:   polygon,
                    polygonId: polygon['_leaflet_id'],
                    latLng:    edge._latlng
                };

                this.edges.push(edge);
                edgeCount++;

                edge.on('mousedown touchstart', function onMouseDown(event) {

                    event.originalEvent.preventDefault();
                    event.originalEvent.stopPropagation();
                    this.movingEdge = event.target;

                }.bind(this));

            }.bind(this));

            return edgeCount;

        },

        /**
         * @method updatePolygonEdge
         * @param edge {Object}
         * @param posX {Number}
         * @param posY {Number}
         * @return {void}
         */
        updatePolygonEdge: function updatePolygon(edge, posX, posY) {

            var updatedLatLng = this.map.containerPointToLatLng(L.point(posX, posY));
            edge.setLatLng(updatedLatLng);

            // Fetch all of the edges in the group based on the polygon.
            var edges = this.edges.filter(function filter(marker) {
                return marker._freedraw.polygon === edge._freedraw.polygon;
            });

            var updatedLatLngs = [];
            edges.forEach(function forEach(marker) {
                updatedLatLngs.push(marker.getLatLng());
            });

            // Update the latitude and longitude values.
            edge._freedraw.polygon.setLatLngs(updatedLatLngs);
            edge._freedraw.polygon.redraw();

        },

        /**
         * @method _attachMouseDown
         * @return {void}
         * @private
         */
        _attachMouseDown: function _attachMouseDown() {

            this.map.on('mousedown touchstart', function onMouseDown(event) {

                /**
                 * Used for determining if the user clicked with the right mouse button.
                 *
                 * @constant RIGHT_CLICK
                 * @type {Number}
                 */
                var RIGHT_CLICK = 2;

                if (event.originalEvent.button === RIGHT_CLICK) {
                    return;
                }

                if (!this.options.multiplePolygons && this.edges.length) {

                    // User is only allowed to create one polygon.
                    return;

                }

                var originalEvent = event.originalEvent;

                originalEvent.stopPropagation();
                originalEvent.preventDefault();

                this.latLngs   = [];
                this.fromPoint = { x: originalEvent.clientX, y: originalEvent.clientY };

                if (this.mode & L.FreeDraw.MODES.CREATE) {

                    // Place the user in create polygon mode.
                    this.creating = true;

                }

            }.bind(this));

        },

        /**
         * @method _attachMouseMove
         * @return {void}
         * @private
         */
        _attachMouseMove: function _attachMouseMove() {

            this.map.on('mousemove touchmove', function onMouseMove(event) {

                var originalEvent = event.originalEvent;

                if (this.movingEdge) {

                    // User is in fact modifying the shape of the polygon.
                    this._editMouseMove(originalEvent);
                    return;

                }

                if (!this.creating) {

                    // We can't do anything else if the user is not in the process of creating a brand-new
                    // polygon.
                    return;

                }

                this._createMouseMove(originalEvent);

            }.bind(this));

        },

        /**
         * @method _editMouseMove
         * @param event {Object}
         * @return {void}
         * @private
         */
        _editMouseMove: function _editMouseMove(event) {

            var pointModel = L.point(event.clientX, event.clientY);

            // Modify the position of the marker on the map based on the user's mouse position.
            var styleDeclaration = this.movingEdge._icon.style;
            styleDeclaration[L.DomUtil.TRANSFORM] = pointModel;

            // Update the polygon's shape in real-time as the user drags their cursor.
            this.updatePolygonEdge(this.movingEdge, pointModel.x, pointModel.y);

        },

        /**
         * @method _attachMouseUpLeave
         * @return {void}
         * @private
         */
        _attachMouseUpLeave: function _attachMouseUpLeave() {

            /**
             * @method completeAction
             * @return {void}
             */
            var completeAction = function completeAction() {

                if (this.movingEdge) {

                    if (!this.options.boundariesAfterEdit) {

                        // Notify of a boundary update immediately after editing one edge.
                        this.notifyBoundaries();

                    } else {

                        // Change the option so that the boundaries will be invoked once the edit mode
                        // has been exited.
                        this.boundaryUpdateRequired = true;

                    }

                    // Recreate the polygon boundaries because we may have straight edges now.
                    this.trimPolygonEdges(this.movingEdge._freedraw.polygon);
                    this.mergePolygons();
                    this.movingEdge = null;

                    return;

                }

                this._createMouseUp();

            }.bind(this);

            this.map.on('mouseup touchend', completeAction);

            var element = $window.document.getElementsByTagName('body')[0];
            element.onmouseleave = completeAction;

        },

        /**
         * @method trimPolygonEdges
         * @param polygon {L.Polygon}
         * @return {void}
         */
        trimPolygonEdges: function trimPolygonEdges(polygon) {

            var latLngs = [];

            if (!polygon._parts[0]) {
                return;
            }

            polygon._parts[0].forEach(function forEach(point) {
                latLngs.push(this.map.layerPointToLatLng(point));
            }.bind(this));

            polygon.setLatLngs(latLngs);
            polygon.redraw();

            this.destroyEdges(polygon);
            this.createEdges(polygon);

        },

        /**
         * @method _createMouseMove
         * @param event {Object}
         * @return {void}
         * @private
         */
        _createMouseMove: function _createMouseMove(event) {

            // Grab the cursor's position from the event object.
            var pointerX = event.clientX,
                pointerY = event.clientY;

            // Resolve the pixel point to the latitudinal and longitudinal equivalent.
            var point = L.point(pointerX, pointerY),
                latLng = this.map.containerPointToLatLng(point);

            // Line data that is fed into the D3 line function we defined earlier.
            var lineData = [this.fromPoint, { x: pointerX, y: pointerY }];

            // Draw SVG line based on the last movement of the mouse's position.
            this.svg.append('path').attr('d', this.lineFunction(lineData))
                    .attr('stroke', '#D7217E').attr('stroke-width', 2).attr('fill', 'none');

            // Take the pointer's position from the event for the next invocation of the mouse move event,
            // and store the resolved latitudinal and longitudinal values.
            this.fromPoint.x = pointerX;
            this.fromPoint.y = pointerY;
            this.latLngs.push(latLng);

        },

        /**
         * @method _createMouseUp
         * @return {void}
         * @private
         */
        _createMouseUp: function _createMouseUp() {

            if (!this.creating) {
                return;
            }

            // User has finished creating their polygon!
            this.creating = false;

            if (this.latLngs.length <= 2) {

                // User has failed to drag their cursor enough to create a valid polygon.
                return;

            }

            if (this.options.hullAlgorithm) {

                // Use the defined hull algorithm.
                this.hull.setMap(this.map);
                var latLngs = this.hull[this.options.hullAlgorithm](this.latLngs);

            }

            // Required for joining the two ends of the free-hand drawing to create a closed polygon.
            this.latLngs.push(this.latLngs[0]);

            // Physically draw the Leaflet generated polygon.
            var polygon = this.createPolygon(latLngs || this.latLngs);

            if (!polygon) {
                return;
            }

            this.latLngs = [];

            if (this.options.createExitMode) {

                // Automatically exit the user from the creation mode.
                this.setMode(this.mode ^ L.FreeDraw.MODES.CREATE);

            }

        }

    });

    /**
     * @constant MODES
     * @type {Object}
     */
    L.FreeDraw.MODES = {
        VIEW:        1,
        CREATE:      2,
        EDIT:        4,
        DELETE:      8,
        APPEND:      16,
        EDIT_APPEND: 4 | 16,
        ALL:         1 | 2 | 4 | 8 | 16
    };

    /**
     * @method Throw
     * @param message {String}
     * @param [path=''] {String}
     * @return {void}
     */
    L.FreeDraw.Throw = function ThrowException(message, path) {

        if (path) {

            if (path.substr(0, 7) === 'http://' || path.substr(0, 8) === 'https://') {

                // Use developer supplied full URL since we've received a FQDN.
                $window.console.error(path);

            } else {

                // Output a link for a more informative message in the EXCEPTIONS.md.
                $window.console.error('See: https://github.com/Wildhoney/Leaflet.FreeDraw/blob/master/EXCEPTIONS.md#' + path);

            }
        }

        // ..And then output the thrown exception.
        throw "Leaflet.FreeDraw: " + message + ".";

    };

})(window, window.L, window.d3, window.ClipperLib);

(function() {

    "use strict";

    /**
     * @module FreeDraw
     * @submodule Hull
     * @author Adam Timberlake
     * @link https://github.com/Wildhoney/Leaflet.FreeDraw
     * @constructor
     */
    L.FreeDraw.Hull = function FreeDrawHull() {};

    /**
     * @property prototype
     * @type {Object}
     */
    L.FreeDraw.Hull.prototype = {

        /**
         * @property map
         * @type {L.Map|null}
         */
        map: null,

        /**
         * @method setMap
         * @param map {L.Map}
         * @return {void}
         */
        setMap: function setMap(map) {
            this.map = map;
        },

        /**
         * @link https://github.com/brian3kb/graham_scan_js
         * @method brian3kbGrahamScan
         * @param latLngs {L.LatLng[]}
         * @return {L.LatLng[]}
         */
        brian3kbGrahamScan: function brian3kbGrahamScan(latLngs) {

            var convexHull     = new ConvexHullGrahamScan(),
                resolvedPoints = [],
                points         = [],
                hullLatLngs    = [];

            latLngs.forEach(function forEach(latLng) {

                // Resolve each latitude/longitude to its respective container point.
                points.push(this.map.latLngToLayerPoint(latLng));

            }.bind(this));

            points.forEach(function forEach(point) {
                convexHull.addPoint(point.x, point.y);
            }.bind(this));

            var hullPoints = convexHull.getHull();

            hullPoints.forEach(function forEach(hullPoint) {
                resolvedPoints.push(L.point(hullPoint.x, hullPoint.y));
            }.bind(this));

            // Create an unbroken polygon.
            resolvedPoints.push(resolvedPoints[0]);

            resolvedPoints.forEach(function forEach(point) {
                hullLatLngs.push(this.map.layerPointToLatLng(point));
            }.bind(this));

            return hullLatLngs;

        },

        /**
         * @link https://github.com/Wildhoney/ConcaveHull
         * @method wildhoneyConcaveHull
         * @param latLngs {L.LatLng[]}
         * @return {L.LatLng[]}
         */
        wildhoneyConcaveHull: function wildhoneyConcaveHull(latLngs) {
            latLngs.push(latLngs[0]);
            return new ConcaveHull(latLngs).getLatLngs();
        }

    }

}());

(function($window, L) {

    "use strict";

    /**
     * @module FreeDraw
     * @submodule Options
     * @author Adam Timberlake
     * @link https://github.com/Wildhoney/Leaflet.FreeDraw
     * @constructor
     */
    L.FreeDraw.Options = function FreeDrawOptions() {};

    /**
     * @property prototype
     * @type {Object}
     */
    L.FreeDraw.Options.prototype = {

        /**
         * @property multiplePolygons
         * @type {Boolean}
         */
        multiplePolygons: true,

        /**
         * @property simplifyPolygon
         * @type {Boolean}
         */
        simplifyPolygon: true,

        /**
         * @property hullAlgorithm
         * @type {String|Boolean}
         */
        hullAlgorithm: 'wildhoneyConcaveHull',

        /**
         * @property boundariesAfterEdit
         * @type {Boolean}
         */
        boundariesAfterEdit: false,

        /**
         * @property createExitMode
         * @type {Boolean}
         */
        createExitMode: true,

        /**
         * @property deleteExitMode
         * @type {Boolean}
         */
        deleteExitMode: false,

        /**
         * @property elbowDistance
         * @type {Number}
         */
        elbowDistance: 10,

        /**
         * @property onlyInDistance
         * @type {Boolean}
         */
        onlyInDistance: false,

        /**
         * @property hullAlgorithms
         * @type {Object}
         */
        hullAlgorithms: {

            /**
             * @property brian3kb/graham_scan_js
             * @type {Object}
             */
            'brian3kb/graham_scan_js': {
                method: 'brian3kbGrahamScan',
                name: 'Graham Scan JS',
                global: 'ConvexHullGrahamScan',
                link: 'https://github.com/brian3kb/graham_scan_js'
            },

            /**
             * @property Wildhoney/ConcaveHull
             * @type {Object}
             */
            'Wildhoney/ConcaveHull': {
                method: 'wildhoneyConcaveHull',
                name: 'Concave Hull',
                global: 'ConcaveHull',
                link: 'https://github.com/Wildhoney/ConcaveHull'
            }

        },

        /**
         * @method addElbowOnlyWithinDistance
         * @param value {Boolean}
         */
        addElbowOnlyWithinDistance: function addElbowOnlyWithinDistance(value) {
            this.onlyInDistance = !!value;
        },

        /**
         * @method setPathClipperPadding
         * @param value {Number}
         * @return {void}
         */
        setPathClipperPadding: function setPathClipperPadding(value) {

            // Prevent polygons outside of the viewport from being clipped.
            L.Path.CLIP_PADDING = value;

        },

        /**
         * @method setMaximumDistanceForElbow
         * @param maxDistance {Number}
         * @return {void}
         */
        setMaximumDistanceForElbow: function setMaximumDistanceForElbow(maxDistance) {
            this.elbowDistance = +maxDistance;
        },

        /**
         * @property attemptMerge
         * @type {Boolean}
         */
        attemptMerge: true,

        /**
         * @property svgClassName
         * @type {String}
         */
        svgClassName: 'tracer',

        /**
         * @property smoothFactor
         * @type {Number}
         */
        smoothFactor: 5,

        /**
         * @property iconClassName
         * @type {String}
         */
        iconClassName: 'polygon-elbow',

        /**
         * @method exitModeAfterCreate
         * @param value {Boolean}
         * @return {void}
         */
        exitModeAfterCreate: function exitModeAfterCreate(value) {
            this.createExitMode = !!value;
        },

        /**
         * @method exitModeAfterDelete
         * @param value {Boolean}
         * @return {void}
         */
        exitModeAfterDelete: function exitModeAfterDelete(value) {
            this.deleteExitMode = !!value;
        },

        /**
         * @method allowMultiplePolygons
         * @param allow {Boolean}
         * @return {void}
         */
        allowMultiplePolygons: function allowMultiplePolygons(allow) {
            this.multiplePolygons = !!allow;
        },

        /**
         * @method setSVGClassName
         * @param className {String}
         * @return {void}
         */
        setSVGClassName: function setSVGClassName(className) {
            this.svgClassName = className;
        },

        /**
         * @method setBoundariesAfterEdit
         * @param value {Boolean}
         * @return {void}
         */
        setBoundariesAfterEdit: function setBoundariesAfterEdit(value) {
            this.boundariesAfterEdit = !!value;
        },

        /**
         * @method smoothFactor
         * @param factor {Number}
         * @return {void}
         */
        setSmoothFactor: function setSmoothFactor(factor) {
            this.smoothFactor = +factor;
        },

        /**
         * @method setIconClassName
         * @param className {String}
         * @return {void}
         */
        setIconClassName: function setIconClassName(className) {
            this.iconClassName = className;
        },

        /**
         * @method setHullAlgorithm
         * @param algorithm {String|Boolean}
         * @return {void}
         */
        setHullAlgorithm: function setHullAlgorithm(algorithm) {

            if (algorithm && !this.hullAlgorithms.hasOwnProperty(algorithm)) {

                // Ensure the passed algorithm is valid.
                return;

            }

            // Resolve the hull algorithm.
            algorithm = this.hullAlgorithms[algorithm];

            if (typeof $window[algorithm.global] === 'undefined') {

                // Ensure hull algorithm module has been included.
                L.FreeDraw.Throw(algorithm.name + ' is a required library for concave/convex hulls', algorithm.link);

            }

            this.hullAlgorithm = algorithm.method;

        }

    };

})(window, window.L, window.d3, window.ClipperLib);

(function() {

    "use strict";

    /**
     * @module FreeDraw
     * @submodule Utilities
     * @author Adam Timberlake
     * @link https://github.com/Wildhoney/Leaflet.FreeDraw
     */
    L.FreeDraw.Utilities = {

        /**
         * Responsible for converting the multiple polygon points into a MySQL object for
         * geo-spatial queries.
         *
         * @method getMySQLMultiPolygon
         * @param latLngGroups {Array}
         * @return {String}
         */
        getMySQLMultiPolygon: function getMySQLMultiPolygon(latLngGroups) {

            var groups = [];

            latLngGroups.forEach(function forEach(latLngs) {

                var group = [];

                latLngs.forEach(function forEach(latLng) {
                    group.push(latLng.lat + ' ' + latLng.lng);
                });

                groups.push('((' + group.join(',') + '))');

            });

            return 'MULTIPOLYGON(' + groups.join(',') + ')';

        },

        /**
         * Responsible to generating disparate MySQL polygons from the lat/long boundaries.
         *
         * @method getMySQLPolygons
         * @param latLngGroups {L.LatLng[]}
         * @returns {Array}
         */
        getMySQLPolygons: function getMySQLPolygons(latLngGroups) {

            var groups = [];

            latLngGroups.forEach(function forEach(latLngs) {

                var group = [];

                latLngs.forEach(function forEach(latLng) {
                    group.push(latLng.lat + ' ' + latLng.lng);
                });

                groups.push('POLYGON((' + group.join(',') + '))');

            });

            return groups;

        }

    };

})();