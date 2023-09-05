import { ColumnRec, DocModel, TableRec, ViewSectionRec } from 'app/client/models/DocModel';
import { IPageWidget } from 'app/client/ui/PageWidgetPicker';
import { getReferencedTableId } from 'app/common/gristTypes';
import { IOptionFull } from 'grainjs';
import assert from 'assert';
import * as gutil from "app/common/gutil";
import isEqual = require('lodash/isEqual');

// some unicode characters
const BLACK_CIRCLE = '\u2022';
const RIGHT_ARROW = '\u2192';

// Describes a link
export interface IPageWidgetLink {

  // The source section id
  srcSectionRef: number;

  // The source column id
  srcColRef: number;

  // The target col id
  targetColRef: number;
}

export const NoLink = linkId({
  srcSectionRef: 0,
  srcColRef: 0,
  targetColRef: 0
});

const NoLinkOption: IOptionFull<string> = {
  label: "Select Widget",
  value: NoLink
};


interface LinkNode {
  // the tableId
  tableId: string;

  // is the table a summary table
  isSummary: boolean;

  // does this node involve an "Attachments" column. Can be tricky if Attachments is one of groupby cols
  isAttachments: boolean;

  // For a summary table, the set of col refs of the groupby columns of the underlying table
  groupbyColumns?: Set<number>;

  // list of ids of the sections that are ancestors to this section according to the linked section
  // relationship. ancestors[0] is this.section, ancestors[last] is oldest ancestor
  ancestors: number[];

  //corresponds to ancestors array, but is 1 shorter.
  // if isAncCursLink[0] == true, that means the link from ancestors[0] to ancestors[1] is a same-table cursor-link
  isAncestorCursorLink: boolean[];

  // the section record. Must be the empty record sections that are to be created.
  section: ViewSectionRec;

  // the column record or undefined for the main section node (ie: the node that does not connect to
  // any particular column)
  column?: ColumnRec;

  // the widget type
  widgetType: string;
}


// Returns true if this node corresponds to the special 'group' reflist column of a summary table
function isSummaryGroup(node: LinkNode): boolean {
  return node.isSummary && node.column?.colId.peek() === "group";
}


// Returns true is the link from `source` to `target` is valid, false otherwise.
function isValidLink(source: LinkNode, target: LinkNode) {

  // section must not be the same
  if (source.section.getRowId() === target.section.getRowId()) {
    return false;
  }

  // table must match
  if (source.tableId !== target.tableId) {
    return false;
  }

  // Can only link to the somewhat special 'group' reflist column of summary tables
  // with another ref/reflist column that isn't also a group column
  // because otherwise it's equivalent to the usual summary table linking but potentially slower
  if (
    isSummaryGroup(source) && (!target.column || isSummaryGroup(target)) ||
    isSummaryGroup(target)
  ) {
    return false;
  }

  // Cannot directly link a summary table to a column referencing the source table.
  // Instead the ref column must link against the group column of the summary table, which is allowed above.
  // The 'group' column name will be hidden from the options so it feels like linking using summaryness.
  if (
    (source.isSummary && !source.column && target.column) ||
    (target.isSummary && !target.column && source.column)
  ) {
    return false;
  }

  // If the target is a summary table and we're linking based on 'summaryness' (i.e. there are no ref columns)
  // then the source must be a less detailed summary table, i.e. having a subset of the groupby columns.
  // (or they should be the same summary table for same-record linking, which this check allows through)
  if (
    !source.column &&
    !target.column &&
    target.isSummary && !(
      source.isSummary &&
      gutil.isSubset(source.groupbyColumns!, target.groupbyColumns!)
    )
  ) {
    return false;
  }

  //cannot select from attachments, even though they're implemented as reflists
  if (source.isAttachments || target.isAttachments) {
    return false;
  }


  // cannot select from chart
  if (source.widgetType === 'chart') {
    return false;
  }

  if (source.widgetType === 'custom') {

    // custom widget do not support linking by columns
    if (source.tableId !== source.section.table.peek().primaryTableId.peek()) {
      return false;
    }

    // custom widget must allow select by
    if (!source.section.allowSelectBy()) {
      return false;
    }
  }

  //The link must not create a cycle, unless it's only same-table cursor-links all the way to target
  if (source.ancestors.includes(target.section.getRowId())) {

    //cycles only allowed for cursor links
    if(source.column || target.column || source.isSummary) {
      return false;
    }

    // Walk backwards along the chain of ancestors
    // - if we hit a non-cursor link before reaching target, then that would be an illegal cycle
    // - when we hit target, we've verified that this is a legal cycle, so break
    //   (ancestors further up the hierarchy past target don't matter, since once we set target.linkSrcSec = src.sec,
    //    they would stop being ancestors of src)
    // NOTE: we're guaranteed to hit target before the end of the array (because of the `if` above)
    //     but I'm paranoid so let's check and throw if it happens
    // ALSO NOTE: isAncestorCursorLink may be 1 shorter than ancestors, but it's accounted for by the above

    for(let i = 0; ; i++) {
      //We made it! All is well
      if(source.ancestors[i] == target.section.getRowId()) {
        break;
      }

      //If we've hit the last ancestor and haven't found target, error out (shouldn't happen)
      if(i == source.ancestors.length-1) { throw Error("Error: Array doesn't include targetSection"); }

      //Need to keep following links back, make sure this one is cursorLink
      if(!source.isAncestorCursorLink[i]) {
        return false;
      }
    }
    console.log("===== selectBy found valid cycle", JSON.stringify(source)); //TODO JV TEMP DEBUG
    //Yay, this is a valid cycle of same-table cursor-links
  }

  return true;
}

// Represents the differents way to reference to a section for linking
type MaybeSection = ViewSectionRec|IPageWidget;


// Returns a list of options with all links that link one of the `source` section to the `target`
// section. Each `opt.value` is a unique identifier (see: linkId() and linkFromId() for more
// detail), and `opt.label` is a human readable representation of the form
// `<section_name>[.<source-col-name>][ -> <target-col-name>]` where the <source-col-name> appears
// only when linking from a reference column, as opposed to linking from the table directly. And the
// <target-col-name> shows only when both <section_name>[.<source-col-name>] is ambiguous.
export function selectBy(docModel: DocModel, sources: ViewSectionRec[],
                         target: MaybeSection): Array<IOptionFull<string>> {
  const sourceNodes = createNodes(docModel, sources);
  const targetNodes = createNodes(docModel, [target]);

  const options = [NoLinkOption];
  for (const srcNode of sourceNodes) {
    const validTargets = targetNodes.filter((tgt) => isValidLink(srcNode, tgt));
    const hasMany = validTargets.length > 1;
    for (const tgtNode of validTargets) {

      // a unique identifier for this link
      const value = linkId({
        srcSectionRef: srcNode.section.getRowId(),
        srcColRef: srcNode.column ? srcNode.column.getRowId() : 0,
        targetColRef: tgtNode.column ? tgtNode.column.getRowId() : 0,
      });

      // a human readable description
      let label = srcNode.section.titleDef();

      // add the source node col name (except for 'group') or nothing for table node
      if (srcNode.column && !isSummaryGroup(srcNode)) {
        label += ` ${BLACK_CIRCLE} ${srcNode.column.label.peek()}`;
      }

      // add the target column name (except for 'group') when clarification is needed, i.e. if either:
      // - target has multiple valid nodes, or
      // - source col is 'group' and is thus hidden.
      //     Need at least one column name to distinguish from simply selecting by summary table.
      //     This is relevant when a table has a column referencing itself.
      if (tgtNode.column && !isSummaryGroup(tgtNode) && (hasMany || isSummaryGroup(srcNode))) {
        label += ` ${RIGHT_ARROW} ${tgtNode.column.label.peek()}`;
      }

      // add the new option
      options.push({ label, value });
    }
  }
  return options;
}

function isViewSectionRec(section: MaybeSection): section is ViewSectionRec {
  return Boolean((section as ViewSectionRec).getRowId);
}

// Create all nodes for sections.
function createNodes(docModel: DocModel, sections: MaybeSection[]) {
  const nodes = [];
  for (const section of sections) {
    if (isViewSectionRec(section)) {
      nodes.push(...fromViewSectionRec(section));
    } else {
      nodes.push(...fromPageWidget(docModel, section));
    }
  }
  return nodes;
}

// Creates an array of LinkNode from a view section record.
function fromViewSectionRec(section: ViewSectionRec): LinkNode[] {
  if (section.isDisposed()) {
    return [];
  }
  const table = section.table.peek();
  const ancestors: number[] = [];

  const isAncestorCursorLink: boolean[] = [];

  for (let sec = section; sec.getRowId(); sec = sec.linkSrcSection.peek()) {
    if (ancestors.includes(sec.getRowId())) {
      // tslint:disable-next-line:no-console
      console.warn(`Links should not create a cycle - section ids: ${ancestors}`);
      //TODO JV: change this to only warn if cycles aren't all Cursor:Same-Table
      break;
    }
    ancestors.push(sec.getRowId());

    //isAncestorCursorLink may be 1 shorter than ancestors, since last ancestor has no incoming link
    // however if we have a cycle (of cursor-links), then they'll be the same length
    if(sec.linkSrcSection.peek().getRowId()) {
      //TODO JV TEMP: Dear god determining if something is a cursor link or not is a nightmare
      const srcCol = sec.linkSrcCol.peek().getRowId();
      const tgtCol = sec.linkTargetCol.peek().getRowId();
      const srcTable = sec.linkSrcSection.peek().table.peek();
      const srcIsSummary = srcTable.primaryTableId.peek() !== srcTable.tableId.peek();
      isAncestorCursorLink.push(srcCol == 0 && tgtCol == 0 && !srcIsSummary);
    }
  }

  const isSummary = table.primaryTableId.peek() !== table.tableId.peek();
  const mainNode: LinkNode = {
    tableId: table.primaryTableId.peek(),
    isSummary,
    isAttachments: isSummary && table.groupByColumns.peek().some(col => col.type.peek() == "Attachments"),
    groupbyColumns: isSummary ? table.summarySourceColRefs.peek() : undefined,
    widgetType: section.parentKey.peek(),
    ancestors,
    isAncestorCursorLink,
    section,
  };

  return fromColumns(table, mainNode);
}

// Creates an array of LinkNode from a page widget.
function fromPageWidget(docModel: DocModel, pageWidget: IPageWidget): LinkNode[] {

  if (typeof pageWidget.table !== 'number') { return []; }

  let table = docModel.tables.getRowModel(pageWidget.table);
  const isSummary = pageWidget.summarize;
  const groupbyColumns = isSummary ? new Set(pageWidget.columns) : undefined;
  let tableExists = true;
  if (isSummary) {
    const summaryTable = docModel.tables.rowModels.find(
      t => t?.summarySourceTable.peek() && isEqual(t.summarySourceColRefs.peek(), groupbyColumns));
    if (summaryTable) {
      // The selected source table and groupby columns correspond to this existing summary table.
      table = summaryTable;
    } else {
      // This summary table doesn't exist yet. `fromColumns` will be using columns from the source table.
      // Make sure it only uses columns that are in the selected groupby columns.
      // The resulting targetColRef will incorrectly be from the source table,
      // but will be corrected in GristDoc.saveLink after the summary table is created.
      tableExists = false;
    }
  }

  const mainNode: LinkNode = {
    tableId: table.primaryTableId.peek(),
    isSummary,
    isAttachments: false, // hmm, we should need a check here in case attachments col is on the main-node link
    // (e.g.: link from summary table with Attachments in group-by) but it seems to work fine as is
    groupbyColumns,
    widgetType: pageWidget.type,
    ancestors: [],
    isAncestorCursorLink: [],
    section: docModel.viewSections.getRowModel(pageWidget.section),
  };

  return fromColumns(table, mainNode, tableExists);
}

function fromColumns(table: TableRec, mainNode: LinkNode, tableExists: boolean = true): LinkNode[] {
  const nodes = [mainNode];
  const columns = table.columns.peek().peek();
  for (const column of columns) {
    if (!tableExists && !mainNode.groupbyColumns!.has(column.getRowId())) {
      continue;
    }
    const tableId = getReferencedTableId(column.type.peek());
    if (tableId) {
      nodes.push({...mainNode, tableId, column, isAttachments: column.type.peek() == "Attachments"});
    }
  }
  return nodes;
}

// Returns an identifier to uniquely identify a link. Here we adopt a simple approach where
// {srcSectionRef: 2, srcColRef: 3, targetColRef: 3} is turned into "[2, 3, 3]".
export function linkId(link: IPageWidgetLink) {
  return JSON.stringify([link.srcSectionRef, link.srcColRef, link.targetColRef]);
}

// Returns link's properties from its identifier.
export function linkFromId(linkid: string): IPageWidgetLink {
  const [srcSectionRef, srcColRef, targetColRef] = JSON.parse(linkid);
  return {srcSectionRef, srcColRef, targetColRef};
}

export class LinkConfig {
  public readonly srcSection: ViewSectionRec;
  public readonly tgtSection: ViewSectionRec;
  // Note that srcCol and tgtCol may be the empty column records if that column is not used.
  public readonly srcCol: ColumnRec;
  public readonly tgtCol: ColumnRec;
  public readonly srcColId: string|undefined;
  public readonly tgtColId: string|undefined;

  // The constructor throws an exception if settings are invalid. When used from inside a knockout
  // computed, the constructor subscribes to all parts relevant for linking.
  constructor(tgtSection: ViewSectionRec) {
    this.tgtCol = tgtSection.linkTargetCol();
    this.srcCol = tgtSection.linkSrcCol();
    this.srcSection = tgtSection.linkSrcSection();
    this.tgtSection = tgtSection;
    this.srcColId = this.srcCol.colId();
    this.tgtColId = this.tgtCol.colId();
    this._assertValid();
  }

  // Check if section-linking configuration is valid, and throw exception if not.
  private _assertValid(): void {
    // Use null for unset cols (rather than an empty ColumnRec) for easier comparisons below.
    const srcCol = this.srcCol?.getRowId() ? this.srcCol : null;
    const tgtCol = this.tgtCol?.getRowId() ? this.tgtCol : null;
    const srcTableId = (srcCol ? getReferencedTableId(srcCol.type()) :
      this.srcSection.table().primaryTableId());
    const tgtTableId = (tgtCol ? getReferencedTableId(tgtCol.type()) :
      this.tgtSection.table().primaryTableId());
    const srcTableSummarySourceTable = this.srcSection.table().summarySourceTable();
    const tgtTableSummarySourceTable = this.tgtSection.table().summarySourceTable();
    try {
      assert(Boolean(this.srcSection.getRowId()), "srcSection was disposed");
      assert(!tgtCol || tgtCol.parentId() === this.tgtSection.tableRef(), "tgtCol belongs to wrong table");
      assert(!srcCol || srcCol.parentId() === this.srcSection.tableRef(), "srcCol belongs to wrong table");
      assert(this.srcSection.getRowId() !== this.tgtSection.getRowId(), "srcSection links to itself");

      // We usually expect srcTableId and tgtTableId to be non-empty, but there's one exception:
      // when linking two summary tables that share a source table (which we can check directly)
      // and the source table is hidden by ACL, so its tableId is empty from our perspective.
      if (!(srcTableSummarySourceTable !== 0 && srcTableSummarySourceTable === tgtTableSummarySourceTable)) {
        assert(tgtTableId, "tgtCol not a valid reference");
        assert(srcTableId, "srcCol not a valid reference");
      }
      assert(srcTableId === tgtTableId, "mismatched tableIds");
    } catch (e) {
      throw new Error(`LinkConfig invalid: ` +
        `${this.srcSection.getRowId()}:${this.srcCol?.getRowId()}[${srcTableId}] -> ` +
        `${this.tgtSection.getRowId()}:${this.tgtCol?.getRowId()}[${tgtTableId}]: ${e}`);
    }
  }
}
