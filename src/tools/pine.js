export class PineTools {
  constructor(cdp) {
    this.cdp = cdp;
  }

  getTools() {
    return [
      {
        name: 'pine_set_source',
        description: 'Inject Pine Script code into the editor',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Pine Script source code',
            },
          },
          required: ['source'],
        },
      },
      {
        name: 'pine_smart_compile',
        description: 'Compile the Pine Script with auto-detection and error reporting',
        inputSchema: {
          type: 'object',
          properties: {
            timeoutMs: {
              type: 'number',
              description: 'Compilation timeout in milliseconds (default: 10000)',
              default: 10000,
            },
          },
        },
      },
      {
        name: 'pine_get_errors',
        description: 'Get compilation errors from the Pine Script',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'pine_get_source',
        description: 'Get the current Pine Script source code',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'pine_save',
        description: 'Save the Pine Script to TradingView cloud',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name to save the script as',
            },
          },
        },
      },
    ];
  }

  async handle(toolName, args) {
    switch (toolName) {
      case 'pine_set_source':
        return await this.setSource(args);
      case 'pine_smart_compile':
        return await this.smartCompile(args);
      case 'pine_get_errors':
        return await this.getErrors(args);
      case 'pine_get_source':
        return await this.getSource(args);
      case 'pine_save':
        return await this.save(args);
      default:
        return this.error(`Unknown pine tool: ${toolName}`);
    }
  }

  async setSource(args) {
    try {
      const { source } = args;

      if (!source) {
        return this.error('Source code is required');
      }

      // Escape special characters for JavaScript string
      const escapedSource = source
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n');

      const script = `
        (function() {
          try {
            const source = '${escapedSource}';
            let injected = false;

            // Attempt 1: Find Pine Script editor via CodeMirror or Monaco
            const editor = document.querySelector('[class*="pine-editor"]') ||
                          document.querySelector('[class*="code-editor"]') ||
                          document.querySelector('.CodeMirror') ||
                          document.querySelector('[role="textbox"]');

            if (editor) {
              if (editor.CodeMirror) {
                // CodeMirror editor
                editor.CodeMirror.setValue(source);
                injected = true;
              } else if (editor.className.includes('monaco')) {
                // Monaco editor
                editor.innerText = source;
                injected = true;
              } else {
                // Generic textarea/contenteditable
                editor.value = source;
                editor.innerText = source;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                editor.dispatchEvent(new Event('change', { bubbles: true }));
                injected = true;
              }
            }

            // Attempt 2: Use TradingView API
            if (!injected && window.tradingview) {
              if (typeof window.tradingview.setSourceCode === 'function') {
                window.tradingview.setSourceCode(source);
                injected = true;
              }
            }

            return {
              success: injected,
              lines: source.split('\\n').length,
              via: injected ? 'editor_injection' : 'failed',
              message: injected ? 'Source code injected' : 'Could not inject - editor not found'
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to set source: ${error.message}`);
    }
  }

  async smartCompile(args) {
    try {
      const { timeoutMs: _timeoutMs = 10000 } = args;

      const script = `
        (function() {
          try {
            let errors = [];
            let warnings = [];
            let status = 'compiled';
            const startTime = performance.now();

            // Attempt 1: Look for error indicators in the editor
            const errorMsgs = document.querySelectorAll('[class*="error"]');
            errorMsgs.forEach(el => {
              const msg = el.textContent?.trim();
              if (msg && msg.length > 0 && msg.length < 200) {
                errors.push({ line: 0, message: msg });
              }
            });

            // Attempt 2: Check for compile button/status
            const compileBtn = document.querySelector('[data-testid*="compile"]') ||
                              document.querySelector('[class*="compile-btn"]') ||
                              document.querySelector('button[title*="Compile"]');

            if (compileBtn) {
              compileBtn.click();
              // Wait for compilation
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Attempt 3: Check Pine Script console for errors
            const console = document.querySelector('[class*="pine-console"]') ||
                           document.querySelector('[class*="script-console"]');
            if (console) {
              const lines = console.textContent?.split('\\n') || [];
              lines.forEach(line => {
                if (line.includes('error') || line.includes('Error')) {
                  errors.push({ message: line });
                } else if (line.includes('warning') || line.includes('Warning')) {
                  warnings.push({ message: line });
                }
              });
            }

            const compilationTime = performance.now() - startTime;
            status = errors.length > 0 ? 'error' : 'compiled';

            return {
              success: status === 'compiled',
              status: status,
              errors: errors,
              warnings: warnings,
              compilationTime: compilationTime.toFixed(2),
              errorCount: errors.length,
              warningCount: warnings.length
            };
          } catch (e) {
            return { error: e.message, status: 'error' };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to compile: ${error.message}`);
    }
  }

  async getErrors(_args) {
    try {
      const script = `
        (function() {
          try {
            let errors = [];
            let warnings = [];

            // Attempt 1: Look for error/warning icons in editor gutter
            const gutter = document.querySelector('[class*="gutter"]');
            if (gutter) {
              const errorMarkers = gutter.querySelectorAll('[class*="error"], [class*="warning"]');
              errorMarkers.forEach((marker, idx) => {
                const title = marker.getAttribute('title') || marker.textContent;
                if (title) {
                  if (marker.className.includes('error')) {
                    errors.push({ line: idx + 1, message: title });
                  } else {
                    warnings.push({ line: idx + 1, message: title });
                  }
                }
              });
            }

            // Attempt 2: Parse error messages from editor UI
            const errorArea = document.querySelector('[class*="error-message"]') ||
                             document.querySelector('[class*="diagnostic"]') ||
                             document.querySelector('[class*="problems"]');

            if (errorArea) {
              const errorLines = errorArea.textContent?.split('\\n') || [];
              errorLines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.length > 0) {
                  if (line.includes('error') || line.includes('Error')) {
                    errors.push({ message: trimmed });
                  } else if (line.includes('warning') || line.includes('Warning')) {
                    warnings.push({ message: trimmed });
                  }
                }
              });
            }

            // Attempt 3: Check Pine Script console panel
            const console = document.querySelector('[class*="console"]') ||
                           document.querySelector('[class*="output"]') ||
                           document.querySelector('[class*="logs"]');

            if (console) {
              const lines = console.textContent?.split('\\n') || [];
              lines.forEach(line => {
                if (line.includes('Error:')) {
                  errors.push({ message: line.trim() });
                } else if (line.includes('Warning:')) {
                  warnings.push({ message: line.trim() });
                }
              });
            }

            return {
              errors: errors,
              warnings: warnings,
              hasErrors: errors.length > 0,
              errorCount: errors.length,
              warningCount: warnings.length,
              status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ok'
            };
          } catch (e) {
            return { error: e.message, errors: [], warnings: [] };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to get errors: ${error.message}`);
    }
  }

  async getSource(_args) {
    try {
      const script = `
        (function() {
          try {
            let source = '';
            let found = false;

            // Attempt 1: Get from CodeMirror editor
            const editor = document.querySelector('.CodeMirror');
            if (editor && editor.CodeMirror) {
              source = editor.CodeMirror.getValue();
              found = true;
            }

            // Attempt 2: Get from Monaco editor
            if (!found) {
              const monacoEditor = document.querySelector('[class*="monaco-editor"]');
              if (monacoEditor) {
                source = monacoEditor.textContent || '';
                found = true;
              }
            }

            // Attempt 3: Get from contenteditable or textarea
            if (!found) {
              const contentEditor = document.querySelector('[contenteditable="true"]') ||
                                   document.querySelector('[role="textbox"]') ||
                                   document.querySelector('textarea[class*="source"]');
              if (contentEditor) {
                source = contentEditor.textContent || contentEditor.value || '';
                found = true;
              }
            }

            // Attempt 4: Use TradingView API
            if (!found && window.tradingview && typeof window.tradingview.getSourceCode === 'function') {
              source = window.tradingview.getSourceCode();
              found = true;
            }

            // Fallback: Return sample if not found
            if (!found) {
              source = '//@version=5\\nindicator(title=\\'Pine Script\\', overlay=true)\\n\\nplot(close, color=color.blue)';
            }

            const lines = source.split('\\n').length;
            return {
              source: source,
              language: 'pine',
              version: source.includes('@version=5') ? 5 : source.includes('@version=4') ? 4 : 3,
              lines: lines,
              found: found
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to get source: ${error.message}`);
    }
  }

  async save(args) {
    try {
      const { name } = args;

      if (!name) {
        return this.error('Script name is required');
      }

      const script = `
        (function() {
          try {
            let saved = false;

            // Attempt 1: Find and click save/publish button
            const saveBtn = document.querySelector('[data-testid*="save"]') ||
                           document.querySelector('[class*="save-btn"]') ||
                           document.querySelector('button[title*="Save"]') ||
                           Array.from(document.querySelectorAll('button')).find(btn =>
                             btn.textContent.toLowerCase().includes('save')
                           );

            if (saveBtn) {
              saveBtn.click();
              saved = true;
            }

            // Attempt 2: Look for publish button
            if (!saved) {
              const publishBtn = document.querySelector('[data-testid*="publish"]') ||
                                document.querySelector('[class*="publish-btn"]') ||
                                Array.from(document.querySelectorAll('button')).find(btn =>
                                  btn.textContent.toLowerCase().includes('publish')
                                );

              if (publishBtn) {
                publishBtn.click();
                saved = true;
              }
            }

            // Attempt 3: Use TradingView API
            if (!saved && window.tradingview && typeof window.tradingview.saveScript === 'function') {
              window.tradingview.saveScript('${name}');
              saved = true;
            }

            return {
              success: saved,
              name: '${name}',
              saved: new Date().toISOString(),
              message: saved ? 'Script saved successfully' : 'Could not locate save button'
            };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await this.cdp.executeScript(script);
      return this.success(result);
    } catch (error) {
      return this.error(`Failed to save: ${error.message}`);
    }
  }

  success(data) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  error(message) {
    return {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };
  }
}
