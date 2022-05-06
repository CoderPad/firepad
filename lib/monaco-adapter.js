'use strict';

const MonacoCollabExt = require('@convergencelabs/monaco-collab-ext')

/**
 * Monaco Adapter
 * Create Pipe between Firebase and Monaco Text Editor
 */
var MonacoAdapter = function () {
  /**
   * @constructor MonacoEditor
   * @param {MonacoEditor} monacoInstance - Editor Instance
   * @prop {MonacoEditor} monaco - Monaco Instance passed as Parameter
   * @prop {MonacoITextModel} monacoModel - Data Model of the Monaco Instance
   * @prop {string[]} lastDocLines - Text for all Lines in the Editor
   * @prop {MonacoSelection} lastCursorRange - Primary Selection of the Editor
   * @prop {function} onChange - Change Event Handler bound Local Object
   * @prop {function} onBlur - Blur Event Handler bound Local Object
   * @prop {function} onFocus - Focus Event Handler bound Local Object
   * @prop {function} onCursorActivity - Cursor Activity Handler bound Local Object
   * @prop {Boolean} ignoreChanges - Should Avoid OnChange Event Handling
   * @prop {MonacoIDisposable} changeHandler - Event Handler for Model Content Change
   * @prop {MonacoIDisposable} didBlurHandler - Event Handler for Focus Lost on Editor Text/Widget
   * @prop {MonacoIDisposable} didFocusHandler - Event Handler for Focus Gain on Editor Text/Widget
   * @prop {MonacoIDisposable} didChangeCursorPositionHandler - Event Handler for Cursor Position Change
   */
  function MonacoAdapter(monacoNamespace, monacoModel, cursorOptions) {
    /** House Keeping */

    // Make sure this looks like a valid monaco instance.
    if (!monacoModel || typeof monacoModel.getValue !== 'function') {
      throw new Error('MonacoAdapter: Incorrect Parameter Recieved in constructor, '
        + 'expected valid Monaco Model Instance');
    }

    /** Monaco Member Variables */
    this.cursorOptions = cursorOptions
    this.monacoNamespace = monacoNamespace;
    this.monacoModel = monacoModel;
    this.lastDocLines = this.monacoModel.getLinesContent();
    this.initialized = false

    /** Monaco Editor Configurations */
    this.callbacks = {};
    this.otherCursors = [];
    this.addedStyleRules = [];
    this.ignoreChanges = false;

    /** Adapter Callback Functions */
    this.onChange = this.onChange.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.onFocus = this.onFocus.bind(this);
    this.onCursorActivity = this.onCursorActivity.bind(this);

    this.changeHandler = this.monacoModel.onDidChangeContent(this.onChange);

    this.didChangeAttachedHandler = this.monacoModel.onDidChangeAttached(() => {
      // Monaco editor is lying, this callback is called BEFORE the model is changed
      setImmediate(() => {
        this.initEditor()
      })
    })
    this.initEditor()
  }

  MonacoAdapter.prototype.detachEditor = function detachEditor() {
    if (this.monacoEditor != null) {
      this.onBlur()
      this.monacoEditor = null
      this.didBlurHandler.dispose();
      this.didFocusHandler.dispose();
      this.didChangeCursorPositionHandler.dispose();

      for (const otherCursor of this.otherCursors) {
        this.removeOtherCursorDecoration(otherCursor)
      }
    }
  }

  MonacoAdapter.prototype.initEditor = function initEditor() {
    const newEditor = this.monacoNamespace.editor.getEditors().find(editor => editor.getModel() === this.monacoModel)

    if (newEditor != this.monacoEditor) {
      this.detachEditor()
      /** Editor Callback Handler */
      this.monacoEditor = newEditor
      if (this.monacoEditor != null) {
        this.didBlurHandler = this.monacoEditor.onDidBlurEditorWidget(this.onBlur);
        this.didFocusHandler = this.monacoEditor.onDidFocusEditorWidget(this.onFocus);
        this.didChangeCursorPositionHandler = this.monacoEditor.onDidChangeCursorPosition(this.onCursorActivity);
        this.lastCursorRange = this.monacoEditor.getSelection();

        this.remoteCursorManager = new MonacoCollabExt.RemoteCursorManager({
          editor: newEditor,
          ...this.cursorOptions
        });
        this.remoteSelectionManager = new MonacoCollabExt.RemoteSelectionManager({
          editor: newEditor
        })

        this.updateOtherCursors()
      }
    }
  }

  /**
   * @method detach - Clears an Instance of Editor Adapter
   */
  MonacoAdapter.prototype.detach = function detach() {
    this.detachEditor()
    this.changeHandler.dispose();
    this.didChangeAttachedHandler.dispose()
  };

  /**
   * @method getCursor - Get current cursor position
   * @returns Firepad Cursor object
   */
  MonacoAdapter.prototype.getCursor = function getCursor() {
    if (this.monacoEditor == null) {
      return null
    }
    var selection = this.monacoEditor.getSelection();

    /** Fallback to last cursor change */
    if (typeof selection === 'undefined' || selection === null) {
      selection = this.lastCursorRange;
    }

    /** Obtain selection indexes */
    var startPos = selection.getStartPosition();
    var endPos = selection.getEndPosition();
    var start = this.monacoModel.getOffsetAt(startPos);
    var end = this.monacoModel.getOffsetAt(endPos);

    /** Return cursor position */
    return new firepad.Cursor(Math.min(start, end), Math.max(start, end));
  };

  /**
   * @method setCursor - Set Selection on Monaco Editor Instance
   * @param {Object} cursor - Cursor Position (start and end)
   * @param {Number} cursor.position - Starting Position of the Cursor
   * @param {Number} cursor.selectionEnd - Ending Position of the Cursor
   */
  MonacoAdapter.prototype.setCursor = function setCursor(cursor) {
    if (this.monacoEditor == null) {
      return
    }
    var position = cursor.position;
    var selectionEnd = cursor.selectionEnd;
    var start = this.monacoModel.getPositionAt(Math.min(position, selectionEnd));
    var end = this.monacoModel.getPositionAt(Math.max(position, selectionEnd));

    /** Create Selection in the Editor */
    this.monacoEditor.setSelection(
      new this.monacoNamespace.Range(
        start.lineNumber, start.column,
        end.lineNumber, end.column
      )
    );
  };

  MonacoAdapter.prototype.updateOtherCursors = function updateOtherCursors() {
    for (const otherCursor of this.otherCursors) {
      this.updateOtherCursorDecoration(otherCursor)
    }
  }

  /**
   * @method setOtherCursor - Set Remote Selection on Monaco Editor
   * @param {Number} cursor.position - Starting Position of the Selection
   * @param {Number} cursor.selectionEnd - Ending Position of the Selection
   * @param {String} color - Hex Color codes for Styling
   * @param {any} clientID - ID number of the Remote Client
   */
  MonacoAdapter.prototype.setOtherCursor = function setOtherCursor(cursor, color, clientID, name) {
    /** House Keeping */
    if (typeof cursor !== 'object' || typeof cursor.position !== 'number'
      || typeof cursor.selectionEnd !== 'number') {

      return false;
    }

    if (typeof color !== 'string' || !color.match(/^#[a-fA-F0-9]{3,6}$/)) {
      return false;
    }

    /** Extract Positions */
    var position = cursor.position;
    var selectionEnd = cursor.selectionEnd;

    if (position < 0 || selectionEnd < 0) {
      return false;
    }

    /** Fetch Client Cursor Information */
    var otherCursor = this.otherCursors.find(function (cursor) {
      return cursor.clientID === clientID;
    });

    /** Initialize empty array, if client does not exist */
    if (!otherCursor) {
      otherCursor = {
        clientID: clientID,
        color,
        name,
        position: cursor.position,
        selectionEnd: cursor.selectionEnd
      };
      this.otherCursors.push(otherCursor);
    } else {
      otherCursor.position = cursor.position
      otherCursor.selectionEnd = cursor.selectionEnd
    }

    this.updateOtherCursorDecoration(otherCursor)

    /** Clear cursor method */
    var _this = this;
    return {
      clear: function clear() {
        const index = _this.otherCursors.indexOf(otherCursor)
        if (index >= 0) {
          _this.otherCursors.splice(index, 1)
        }
        _this.removeOtherCursorDecoration(otherCursor)
      }
    };
  }

  MonacoAdapter.prototype.removeOtherCursorDecoration = function removeOtherCursorDecoration(otherCursor) {
    if (otherCursor.cursor != null) {
      otherCursor.cursor.dispose()
      otherCursor.cursor = undefined
    }
    if (otherCursor.selection != null) {
      otherCursor.selection.dispose()
      otherCursor.selection = undefined
    }
  }

  MonacoAdapter.prototype.updateOtherCursorDecoration = function updateOtherCursorDecoration(otherCursor) {
    if (this.monacoEditor == null) {
      return
    }

    if (otherCursor.cursor == null) {
      otherCursor.cursor = this.remoteCursorManager.addCursor(otherCursor.clientID, otherCursor.color, otherCursor.name)
    }
    if (otherCursor.selection == null) {
      otherCursor.selection = this.remoteSelectionManager.addSelection(otherCursor.clientID, otherCursor.color, otherCursor.name)
    }
    if (otherCursor.position === otherCursor.selectionEnd) {
      otherCursor.selection.hide()
      otherCursor.cursor.setOffset(otherCursor.position)
      otherCursor.cursor.show()
    } else {
      otherCursor.cursor.hide()
      otherCursor.selection.setOffsets(
        Math.min(otherCursor.position, otherCursor.selectionEnd),
        Math.max(otherCursor.position, otherCursor.selectionEnd)
      )
      otherCursor.selection.show()
    }
  };

  /**
   * @method registerCallbacks - Assign callback functions to internal property
   * @param {function[]} callbacks - Set of callback functions
   */
  MonacoAdapter.prototype.registerCallbacks = function registerCallbacks(callbacks) {
    this.callbacks = Object.assign({}, this.callbacks, callbacks);
  };

  /**
   * @method registerUndo
   * @param {function} callback - Callback Handler for Undo Event
   */
  MonacoAdapter.prototype.registerUndo = function registerUndo(callback) {
    if (typeof callback === 'function') {
      this.monacoModel.undo = callback;
    } else {
      throw new Error('MonacoAdapter: registerUndo method expects a '
        + 'callback function in parameter');
    }
  };

  /**
   * @method registerRedo
   * @param {function} callback - Callback Handler for Redo Event
   */
  MonacoAdapter.prototype.registerRedo = function registerRedo(callback) {
    if (typeof callback === 'function') {
      this.monacoModel.redo = callback;
    } else {
      throw new Error('MonacoAdapter: registerRedo method expects a '
        + 'callback function in parameter');
    }
  };

  /**
   * @method operationFromMonacoChanges - Convert Monaco Changes to OT.js Ops
   * @param {Object} change - Change in Editor
   * @param {string} content - Last Editor Content
   * @param {Number} offset - Offset between changes of same event
   * @returns Pair of Operation and Inverse
   * Note: OT.js Operation expects the cursor to be at the end of content
   */
  MonacoAdapter.prototype.operationFromMonacoChanges = function operationFromMonacoChanges(change, content, offset) {
    /** Change Informations */
    var text = change.text;
    var rangeLength = change.rangeLength;
    var rangeOffset = change.rangeOffset;

    /** Additional SEEK distance */
    var restLength = content.length + offset - rangeOffset;

    /** Declare OT.js Operation Variables */
    var change_op, inverse_op, replaced_text;

    if (text.length === 0 && rangeLength > 0) {
      /** Delete Operation */
      replaced_text = content.slice(rangeOffset, rangeOffset + rangeLength);

      change_op = new firepad.TextOperation()
        .retain(rangeOffset)
        .delete(rangeLength)
        .retain(restLength - rangeLength);

      inverse_op = new firepad.TextOperation()
        .retain(rangeOffset)
        .insert(replaced_text)
        .retain(restLength - rangeLength);
    } else if (text.length > 0 && rangeLength > 0) {
      /** Replace Operation */
      replaced_text = content.slice(rangeOffset, rangeOffset + rangeLength);

      change_op = new firepad.TextOperation()
        .retain(rangeOffset)
        .delete(rangeLength)
        .insert(text)
        .retain(restLength - rangeLength);

      inverse_op = new firepad.TextOperation()
        .retain(rangeOffset)
        .delete(text.length)
        .insert(replaced_text)
        .retain(restLength - rangeLength);
    } else {
      /** Insert Operation */
      change_op = new firepad.TextOperation()
        .retain(rangeOffset)
        .insert(text)
        .retain(restLength);

      inverse_op = new firepad.TextOperation()
        .retain(rangeOffset)
        .delete(text)
        .retain(restLength);
    }

    return [ change_op, inverse_op ];
  };

  /**
   * @method onChange - OnChange Event Handler
   * @param {Object} event - OnChange Event Delegate
   */
  MonacoAdapter.prototype.onChange = function onChange(event) {
    var _this = this;

    if (!this.ignoreChanges) {
      var content = this.lastDocLines.join(this.monacoModel.getEOL());
      var offset = 0;

      /** If no change information recieved */
      if (!event.changes) {
        var op = new firepad.TextOperation().retain(content.length);
        this.trigger('change', op, op);
      }

      /** Iterate through all changes */
      event.changes.forEach(function (change) {
        var pair = _this.operationFromMonacoChanges(change, content, offset);
        offset += pair[0].targetLength - pair[0].baseLength;

        _this.trigger.apply(_this, ['change'].concat(pair));
      });

      /** Update Editor Content */
      this.lastDocLines = this.monacoModel.getLinesContent();
    }
  };

  /**
   * @method trigger - Event Handler
   * @param {string} event - Event name
   * @param  {...any} args - Callback arguments
   */
  MonacoAdapter.prototype.trigger = function trigger(event) {
    if (!this.callbacks.hasOwnProperty(event)) {
      return;
    }

    var action = this.callbacks[event];

    if (! typeof action === 'function') {
      return;
    }

    var args = [];

    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args.push(arguments[i]);
      }
    }

    action.apply(null, args);
  };

  /**
   * @method onBlur - Blur event handler
   */
  MonacoAdapter.prototype.onBlur = function onBlur() {
    if (this.monacoEditor == null || this.monacoEditor.getSelection() == null || this.monacoEditor.getSelection().isEmpty()) {
      this.trigger('blur');
    }
  };

  /**
   * @method onFocus - Focus event handler
   */
  MonacoAdapter.prototype.onFocus = function onFocus() {
    this.trigger('focus');
  };

  /**
   * @method onCursorActivity - CursorActivity event handler
   */
  MonacoAdapter.prototype.onCursorActivity = function onCursorActivity() {
    var _this = this;

    setTimeout(function () {
      return _this.trigger('cursorActivity');
    }, 1);
  };

  /**
   * @method applyOperation
   * @param {Operation} operation - OT.js Operation Object
   */
  MonacoAdapter.prototype.applyOperation = function applyOperation(operation) {
    if (!operation.isNoop()) {
      this.ignoreChanges = true;
    }

    /** Ensure whitespace is not automatically trimmed while executing edits */
    var userWhitespaceSetting = this.monacoModel.getOptions().trimAutoWhitespace
    this.monacoModel.updateOptions({ trimAutoWhitespace: false })

    /** Get Operations List */
    var opsList = operation.ops;

    if (!this.initialized) {
      this.initialized = true
      if (opsList.length === 1 && opsList[0].isInsert()) {
        const insertOp = opsList[0]
        if (insertOp.text === this.monacoModel.getValue()) {
          // Model already up to date
        } else {
          // Replace the content
          this.monacoModel.applyEdits([{
            range: this.monacoModel.getFullModelRange(),
            text: insertOp.text
          }]);
          if (this.monacoEditor != null) {
            this.monacoEditor.setSelection({
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1
            });
          }
        }
      } else {
        // Empty the model
        this.monacoModel.applyEdits([{
          range: this.monacoModel.getFullModelRange(),
          text: ''
        }]);
      }
    } else {
      var index = 0;
      const monacoModel = this.monacoModel
      const edits = opsList.flatMap(op => {
        /** Retain Operation */
        if (op.isRetain()) {
          index += op.chars;
        } else if (op.isInsert()) {
          /** Insert Operation */
          var pos = monacoModel.getPositionAt(index);

          return [{
            range: new this.monacoNamespace.Range(
              pos.lineNumber, pos.column,
              pos.lineNumber, pos.column
            ),
            text: op.text,
            forceMoveMarkers: true
          }];
        } else if (op.isDelete()) {
          /** Delete Operation */
          var from = monacoModel.getPositionAt(index);
          var to = monacoModel.getPositionAt(index + op.chars);

          index += op.chars;

          return [{
            range: new this.monacoNamespace.Range(
              from.lineNumber, from.column,
              to.lineNumber, to.column
            ),
            text: '',
            forceMoveMarkers: true
          }];
        }

        return []
      });

      monacoModel.applyEdits(edits)
    }

    /** Restore whitespace auto-trim setting */
    this.monacoModel.updateOptions({ trimAutoWhitespace: userWhitespaceSetting })

    /** Update Editor Content and Reset Config */
    this.lastDocLines = this.monacoModel.getLinesContent();
    this.ignoreChanges = false;
  };

  /**
   * @method invertOperation
   * @param {Operation} operation - OT.js Operation Object
   */
  MonacoAdapter.prototype.invertOperation = function invertOperation(operation) {
    return operation.invert(this.monacoModel.getValue());
  };

  return MonacoAdapter;
}(); /** Export Module */


firepad.MonacoAdapter = MonacoAdapter;
