function btoa_(str) {
    // first we use encodeURIComponent to get percent-encoded Unicode,
    // then we convert the percent encodings into raw bytes which
    // can be fed into btoa.
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        function toSolidBytes(match, p1) {
            return String.fromCharCode('0x' + p1);
    }));
}

function atob_(str) {
    // Going backwards: from bytestream, to percent-encoding, to original string.
    return decodeURIComponent(atob(str).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
}

(function (define) {
    "use strict";

    (function (root, factory) {
        if (typeof define === "function" && define.amd) {
            define(factory);
        } else if (typeof exports === "object") {
            module.exports = factory();
        } else {
            root.TreeView = factory();
        }
    })(window, function () {
        return (function () {
            /** List of events supported by the tree view */
            var events = [
                "expand",
                "expandAll",
                "collapse",
                "collapseAll",
                "select",
                "context",
                "click",
            ];

            /**
             * A utilite function to check to see if something is a DOM object
             * @param {object} Object to test
             * @returns {boolean} If the object is a DOM object
             */
            function isDOMElement(obj) {
                try {
                    return obj instanceof HTMLElement;
                } catch (e) {
                    // Some browsers don't support using the HTMLElement so some extra
                    // checks are needed.
                    return (
                        typeof obj === "object" &&
                        obj.nodeType === 1 &&
                        typeof obj.style === "object" &&
                        typeof obj.ownerDocument === "object"
                    );
                }
            }

            /**
             * A forEach that will work with a NodeList and generic Arrays
             * @param {array|NodeList} arr The array to iterate over
             * @param {function} callback Function that executes for each element. First parameter is element, second is index
             * @param {object} The context to execute callback with
             */
            function forEach(arr, callback, scope) {
                var i,
                    len = arr.length;
                for (i = 0; i < len; i += 1) {
                    callback.call(scope, arr[i], i);
                }
            }

            /**
             * Emit an event from the tree view
             * @param {string} name The name of the event to emit
             */
            function emit(instance, name) {
                var args = [].slice.call(arguments, 2);
                if (events.indexOf(name) > -1) {
                    if (
                        instance.handlers[name] &&
                        instance.handlers[name] instanceof Array
                    ) {
                        forEach(instance.handlers[name], function (handle) {
                            window.setTimeout(function () {
                                handle.callback.apply(handle.context, args);
                            }, 0);
                        });
                    }
                } else {
                    throw new Error(
                        name + " event cannot be found on TreeView."
                    );
                }
            }

            function get_leaves(parent) {
                return parent.parentNode.querySelector(".tree-child-leaves");
            }

            /**
             * Renders the tree view in the DOM
             */
            function render(self) {
                // Tree rendering
                var container = isDOMElement(self.node)
                    ? self.node
                    : document.getElementById(self.node);
                var leaves = [],
                    click,
                    toggleaf,
                    ctxmenu;
                var renderLeaf = function (item) {
                    if ('hidden' in item) {
                        // don't show the node if the hidden attribute is set
                        return null;
                    }
                    if (self.directorymode && item.children && item.children.length == 0) {
                        // don't show any leafs when in directories mode
                        return null;
                    }
                    var leaf = document.createElement("div");
                    var content = document.createElement("div");
                    var text = document.createElement("div");
                    var expando = document.createElement("div");

                    leaf.setAttribute("class", "tree-leaf");
                    content.setAttribute("class", "tree-leaf-content");
                    content.setAttribute("data-item", JSON.stringify(item));
                    if ("path" in item) {
                        leaf.setAttribute("id", btoa_(item.path).replaceAll('=','_'));
                    }

                    text.setAttribute("class", "tree-leaf-text");
                    text.textContent = item.name;
                    expando.setAttribute(
                        "class",
                        "tree-expando " + (item.expanded ? "expanded" : "")
                    );
                    expando.textContent = item.expanded ? "-" : "+";
                    content.appendChild(expando);
                    content.appendChild(text);
                    leaf.appendChild(content);
                    if (item.children && item.children.length > 0) {
                        var children = document.createElement("div");
                        children.setAttribute("class", "tree-child-leaves");
                        forEach(item.children, function (child) {
                            var childLeaf = renderLeaf(child);
                            if (childLeaf) {
                                // renderLeaf will return null if this leaf should not be displayed
                                children.appendChild(childLeaf);
                            }
                        });
                        if (!item.expanded) {
                            children.classList.add("hidden");
                        }
                        leaf.appendChild(children);
                    } else {
                        expando.classList.add("hidden");
                    }
                    return leaf;
                };

                forEach(self.data, function (item) {
                    if (self.directorymode && item.children && item.children.length == 0) {
                        // Don't show any leafs when in directory mode
                        return;
                    }
                    leaves.push(renderLeaf.call(self, item));
                });
                container.innerHTML = leaves
                    .map(function (leaf) {
                        return leaf.outerHTML;
                    })
                    .join("");

                ctxmenu = function (e) {
                    var parent = (e.target || e.currentTarget).parentNode;
                    var data = JSON.parse(parent.getAttribute("data-item"));

                    e.preventDefault();

                    emit(self, "context", {
                        target: e,
                        data: data,
                    });
                };

                click = function (e) {
                    var target = (e.target || e.currentTarget);
                    var parent = target.parentNode;
                    var data = JSON.parse(parent.getAttribute("data-item"));

                    emit(self, "click", {
                        target: e,
                        data: data,
                    });
                };

                toggleaf = function (e) {
                    var target = (e.target || e.currentTarget);
                    var parent = target.parentNode;
                    var leaves =
                        parent.parentNode.querySelector(".tree-child-leaves");
                    if (leaves) {
                        if (leaves.classList.contains("hidden")) {
                            self.expand(parent);
                        } else {
                            self.collapse(parent);
                        }
                    }
                };

                forEach(
                    container.querySelectorAll(".tree-leaf-text"),
                    function (node) {
                        node.onclick = click;
                        node.oncontextmenu = ctxmenu;
                    }
                );
                
                forEach(
                    container.querySelectorAll('.tree-expando'),
                    function (node) {
                        node.onclick = toggleaf;
                    }
                );

            }

            /**
             * @constructor
             * @property {object} handlers The attached event handlers
             * @property {object} data The JSON object that represents the tree structure
             * @property {DOMElement} node The DOM element to render the tree in
             */
            function TreeView(data, node, directorymode) {
                this.handlers = {};
                this.node = node;
                this.data = data;
                this.directorymode = false;
                if (typeof(directorymode) == 'boolean') {
                    this.directorymode = directorymode;
                }
                render(this);
            }

            TreeView.prototype.getAnscestorsIDs = function(id) {
                var self = this;
                var internal_id = btoa_(id).replaceAll('=', '_');
                var node = document.getElementById(internal_id);
                var anscestors = [];
                while (true) {
                    internal_id = node.getAttribute('id');

                    if (internal_id == self.node) {
                        break;
                    }

                    if (internal_id !== null) { 
                        //console.log(internal_id);
                        var txtid = atob_(internal_id.replaceAll('_','='));
                        anscestors.push(txtid)
                    }

                    node = node.parentNode;

                } 
                return anscestors;
            }

            /*
            TreeView.prototype.scroll_into_view = function(node) {
                var self = this;
                var container = document.getElementById(self.node);
                const nodeTop = node.offsetTop;
                const nodeBottom = nodeTop + node.offsetHeight;
                const containerTop = container.scrollTop;
                const containerBottom = containerTop + container.offsetHeight;
            
                if (nodeBottom > containerBottom) {
                    // Scroll down
                    container.scrollTop = nodeBottom - container.offsetHeight;
                } else if (nodeTop < containerTop) {
                    // Scroll up
                    container.scrollTop = nodeTop;
                }
            }
            */

            TreeView.prototype.scroll_into_view = function(node) {
                var self = this;
                var node = node.querySelector('.tree-leaf-text');
                var container = document.getElementById(self.node);
                const elemRect = node.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
              
                // Check if the element is out of view at the top or bottom of the container
                if (elemRect.bottom > containerRect.bottom) {
                    // Element is below the visible area of the container, scroll down
                    node.scrollIntoView(false);
                } else if (elemRect.top < containerRect.top) {
                    // Element is above the visible area of the container, scroll up
                    node.scrollIntoView(true);
                }
            }

            TreeView.prototype.getNode = function(id) {
                var b64id = btoa_(id).replaceAll('=', '_')
                return document.getElementById(b64id);
            }

            /**
             * Expands a leaflet by the expando or the leaf text
             * @param {DOMElement} node The parent node that contains the leaves
             */
            TreeView.prototype.expand = function (node, skipEmit) {
                var expando = node.querySelector(".tree-expando");
                var leaves = get_leaves(node);
                if (leaves == null) {
                    return;
                }
                expando.textContent = "-";
                leaves.classList.remove("hidden");
                if (skipEmit) {
                    return;
                }
                emit(this, "expand", {
                    target: node,
                    leaves: leaves,
                });
            };

            function update_displayed_leaves() {
                const elements = document.querySelectorAll('.tree-leaf');
                var displayed_leaves = [];
                var selIndex = -1;
                for (var i=0; i<elements.length; i++) {
                    var el = elements[i];
                    if (el.offsetParent !== null) {
                        displayed_leaves.push(el);
                        if (el.childNodes[0].childNodes[1].classList.contains('nowselected')) {
                            selIndex = displayed_leaves.length - 1;
                        }
                    }  
                }
                return {leaves:displayed_leaves, selindex:selIndex}
            }
    
            TreeView.prototype.clickBeforeSelected = function() {
                var self = this;
                var displayed = update_displayed_leaves();
                if (displayed.selindex < 1) {
                    return;
                }
                self.clickNode(displayed.leaves[displayed.selindex - 1]);
            }
              
            TreeView.prototype.clickAfterSelected = function() {
                var self = this;
                var displayed = update_displayed_leaves();
                if (displayed.selindex == -1) {
                    return;
                }
                if (displayed.selindex == displayed.leaves.length - 1) {
                    return;
                }

                self.clickNode(displayed.leaves[displayed.selindex + 1]);
            }

            TreeView.prototype.expandAtSelected = function() {
                var self = this;
                var node = document.querySelector('.nowselected');
                var parent = node.parentNode;
                if (parent && parent.parentNode) {
                    self.expand(parent.childNodes[0]);
                    self.expand(parent.parentNode.childNodes[0]);
                }
            }

            TreeView.prototype.clickFirstItem = function() {
                var self = this;
                self.clickNode(document.querySelector('.tree-leaf'))
            }

            TreeView.prototype.collapseAtSelected = function() {
                var self = this;
                var node = document.querySelector('.nowselected');
                var parent = node.parentNode;
                var gparent = parent.parentNode;

                if (parent && gparent) {
                    const visibleElements = Array.from(gparent.querySelectorAll('.tree-leaf-text')).filter(el => {
                        return el.offsetParent !== null;
                    });
                    var tl = visibleElements.length;
                    if (tl > 1) {
                        self.collapse(parent.childNodes[0]);
                        self.collapse(gparent.childNodes[0]);
                    }
                    else {
                        // This is a leaf. Collapse the parent branch
                        var gparent2 = gparent.parentNode;
                        if (gparent2 && gparent2.getAttribute('id') != self.node && gparent2.parentNode) {
                            self.collapse(gparent2.childNodes[0])
                            self.collapse(gparent2.parentNode.childNodes[0])
                            self.clickNode(gparent2.parentNode)
                        }
                    }
                }
            }

            TreeView.prototype.selectNode = function(selNode) {
                document.querySelectorAll('.nowselected').forEach(function(node) {
                    node.classList.remove('nowselected');
                });
    
                // Add the "nowselected" class to the clicked element
                if (selNode) {
                    if (!selNode.classList.contains('tree-leaf-text')) {
                        selNode = selNode.querySelector('.tree-leaf-text')
                    }
                    selNode.classList.add('nowselected');
                }
            }
    
            TreeView.prototype.clickNode = function(node) {
                var self = this;
                const element = node.querySelector('.tree-leaf-text');
                const event = new MouseEvent('click', { bubbles: true, cancelable: true });
                self.scroll_into_view(node);
                element.dispatchEvent(event);
            }

            TreeView.prototype.expandBranchTo = function(node) {
                var self = this;
                if (node.childNodes && node.childNodes.length > 1) {
                    node = node.childNodes[1];
                }
                var id = node.getAttribute('id')
                while (id !== self.node) {
                    if (node.classList.contains('tree-leaf')) {
                        var tree_leaf_content = node.childNodes[0];
                        var tree_expando = tree_leaf_content.childNodes[0];
                        tree_expando.textContent = "-";
                    }
                    node.classList.remove("hidden");
                    node = node.parentNode;
                    id = node.getAttribute('id')
                }
            };

            TreeView.prototype.expandAll = function () {
                var self = this;
                var nodes = document
                    .getElementById(self.node)
                    .querySelectorAll(".tree-expando");
                forEach(nodes, function (node) {
                    var parent = node.parentNode;
                    var leaves = get_leaves(node);
                    if (parent && leaves && parent.hasAttribute("data-item")) {
                        self.expand(parent, true);
                    }
                });
                emit(this, "expandAll", {});
            };

            /**
             * Collapses a leaflet by the expando or the leaf text
             * @param {DOMElement} node The parent node that contains the leaves
             */
            TreeView.prototype.collapse = function (node) {
                var expando = node.querySelector(".tree-expando");
                
                if (expando) {
                    expando.textContent = "+";
                    var leaves = get_leaves(node);
                    if (leaves) {
                        leaves.classList.add("hidden");
                    }
                }
            };

            /**
             */
            TreeView.prototype.collapseAll = function () {
                var self = this;
                var nodes = document
                    .getElementById(self.node)
                    .querySelectorAll(".tree-expando");
                forEach(nodes, function (node) {
                    var parent = node.parentNode;
                    self.collapse(parent, true);
                });
            };

            /**
             * Attach an event handler to the tree view
             * @param {string} name Name of the event to attach
             * @param {function} callback The callback to execute on the event
             * @param {object} scope The context to call the callback with
             */
            TreeView.prototype.on = function (name, callback, scope) {
                if (events.indexOf(name) > -1) {
                    if (!this.handlers[name]) {
                        this.handlers[name] = [];
                    }
                    this.handlers[name].push({
                        callback: callback,
                        context: scope,
                    });
                } else {
                    throw new Error(name + " is not supported by TreeView.");
                }
            };

            /**
             * Deattach an event handler from the tree view
             * @param {string} name Name of the event to deattach
             * @param {function} callback The function to deattach
             */
            TreeView.prototype.off = function (name, callback) {
                var index,
                    found = false;
                if (this.handlers[name] instanceof Array) {
                    this.handlers[name].forEach(function (handle, i) {
                        index = i;
                        if (handle.callback === callback && !found) {
                            found = true;
                        }
                    });
                    if (found) {
                        this.handlers[name].splice(index, 1);
                    }
                }
            };

            return TreeView;
        })();
    });
})(window.define);
