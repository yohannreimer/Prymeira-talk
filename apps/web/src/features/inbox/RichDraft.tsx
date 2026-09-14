import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { parseWhatsappText, serializeWhatsappText } from './whatsapp-text';
import './composer-enhancements.css';
function insertedText(text: string) {
  const paragraphs = parseWhatsappText(text).content!;
  return paragraphs.length === 1 ? paragraphs[0].content ?? [] : paragraphs;
}
export interface RichDraftHandle { focus(): void; format(mark: 'bold' | 'italic'): void; insertText(text: string): void }
export const RichDraft = forwardRef<RichDraftHandle, { value: string; disabled: boolean; onChange(value: string): void; onFormatChange(value: { bold: boolean; italic: boolean }): void }>(function RichDraft(props, ref) {
  const latest = useRef(props); latest.current = props;
  const written = useRef(props.value);
  const editor = useEditor({
    extensions: [StarterKit.configure({ blockquote: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, heading: false, code: false, codeBlock: false, horizontalRule: false, strike: false, link: false, underline: false, trailingNode: false })],
    content: parseWhatsappText(props.value),
    editable: !props.disabled,
    enableInputRules: false, enablePasteRules: false,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Mensagem', 'aria-multiline': 'true', class: 'composer-rich-input', 'data-placeholder': 'Escreva uma mensagem...' },
      handleKeyDown(view, event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !view.composing) {
          event.preventDefault(); view.dom.closest('form')?.requestSubmit(); return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        event.preventDefault(); editor?.commands.insertContent(insertedText(text)); return true;
      }
    },
    onUpdate({ editor }) { const value = serializeWhatsappText(editor.getJSON()); written.current = value; latest.current.onChange(value); },
    onTransaction({ editor }) { latest.current.onFormatChange({ bold: editor.isActive('bold'), italic: editor.isActive('italic') }); }
  });
  useEffect(() => { editor?.setEditable(!props.disabled); }, [editor, props.disabled]);
  useEffect(() => {
    if (editor && props.value !== written.current) { written.current = props.value; editor.commands.setContent(parseWhatsappText(props.value), { emitUpdate: false }); }
  }, [editor, props.value]);
  useImperativeHandle(ref, () => ({
    focus: () => { editor?.commands.focus(); },
    format: mark => { if (!props.disabled) editor?.chain().focus().toggleMark(mark).run(); },
    insertText: text => { if (!props.disabled) editor?.chain().focus().insertContent(insertedText(text)).run(); }
  }), [editor, props.disabled]);
  return <EditorContent editor={editor} className="composer-rich-shell" />;
});
