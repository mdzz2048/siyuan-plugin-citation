import SiYuanPluginCitation from "./index";
import { SiyuanData } from "./api/base-api";
import {
  STORAGE_NAME, isDev, citeLink, DISALLOWED_FILENAME_CHARACTERS_RE
} from "./utils/constants";
import {
  generateFromTemplate
} from "./utils/templates";
import { ILogger, createLogger } from "./utils/simple-logger";

const refReg = /\(\((.*?)\)\)/g;
const refRegInTemplate = /\(\((.*?)\"(.*?)\"\)\)/g;

// 根据输入更新文献库和引用文档，并维护本文档中的引用次序
export class Reference {
  plugin: SiYuanPluginCitation;
  private logger: ILogger;

  constructor(plugin: SiYuanPluginCitation) {
    this.plugin = plugin;
    this.checkRefDirExist();
    this.logger = createLogger("reference");
  }

  public async updateLiteratureNote(citekey: string) {
    const notebookId = this.plugin.data[STORAGE_NAME].referenceNotebook as string;
    const refPath = this.plugin.data[STORAGE_NAME].referencePath as string;
    const titleTemplate = this.plugin.data[STORAGE_NAME].titleTemplate as string;
    const noteTemplate = this.plugin.data[STORAGE_NAME].noteTemplate as string;
    const res = await this.plugin.kernelApi.searchFileWithName(notebookId, refPath, citekey);
    const data = res.data as any[];
    const entry = await this.plugin.database.getContentByCitekey(citekey);
    if (isDev) this.logger.info("从database中获得文献内容 =>", entry);
    if (!entry) {
      if (isDev) this.logger.error("找不到文献数据");
      this.plugin.noticer.error(this.plugin.i18n.errors.getLiteratureFailed);
      return null;
    }
    const noteTitle = generateFromTemplate(titleTemplate, entry);
    noteTitle.replace(DISALLOWED_FILENAME_CHARACTERS_RE, "_");
    const literatureNote = generateFromTemplate(noteTemplate, entry);
    if (data.length) {
      const literatureId = data[0].root_id;
      // 文件存在就更新文件内容
      return await this.plugin.kernelApi.updateBlockContent(literatureId, literatureNote);
    } else {
      //文件不存在就新建文件
      return await this.plugin.kernelApi.createDocWithMd(notebookId, refPath + `/${noteTitle}`, literatureNote).then(async res => {
        const id  = String(res.data);
        // 新建文件之后要设定命名
        await this.plugin.kernelApi.setNameOfBlock(id, citekey);
        // 新建文件之后也要更新对应字典
        this.plugin.ck2idDict[citekey] = id;
        this.plugin.id2ckDict[id] = citekey;
      });
    }
  }

  public async updateLiteratureLink(fileId: string): Promise<SiyuanData[]> {
    // 获得所有含有文献引用的块，用于内容更新
    const res = await this.plugin.kernelApi.getCitedBlocks(fileId);
    const data = res.data as any[];
    const citedBlocks = data.map(block => {
      return {
        id: block.id as string,
        content: block.markdown as string
      };
    });
    const literatureEnum = await this.getLiteratureEnum(fileId);
    const writeList:{content: string, blockId: string}[] = [];
    const cancelCiteList:{blockId: string}[] = [];
    const generatePromise = citedBlocks.map(async block => {
      const reg = refReg;
      let isModified = false;
      // 因为replace只能同步使用，所以先构建替换表
      const matchRes = block.content.matchAll(reg);
      const replaceList: {[key: string]: string} = {};
      for (const match of matchRes) {
        const key = match[1].split(" ")[0];
        const anchor = match[1].slice(key.length + 1);
        const idx = literatureEnum.indexOf(key);
        if (idx != -1) {
          let link = "";
          if (this.plugin.data[STORAGE_NAME].customCiteText) {
            link = await this.generateOnlyCiteLink(this.plugin.id2ckDict[key], idx);
          } else {
            link = await this.generateCiteLink(this.plugin.id2ckDict[key], idx);
          }
          if (isDev) this.logger.info("更新文献引用 =>", link);
          if (!link) continue;
          if (anchor != `"${link}"`) {
            isModified = true;
          }
          replaceList[key] = citeLink.replace("${id}", key).replace("${link}", link);
        }
      }
      const newContent = block.content.replace(reg, (match, p1) => {
        const key = p1.split(" ")[0];
        if (Object.keys(replaceList).indexOf(key) != -1) return replaceList[key];
        return match;
      });
      if (isModified) {
        writeList.push({
          content: newContent,
          blockId: block.id as string
        });
      }
    });
    await Promise.all(generatePromise);
    if (isDev) this.logger.info("取消引用列表 =>", cancelCiteList);
    if (isDev) this.logger.info("写入引用列表 =>", writeList);
    const update = writeList.map(witem => {
      return this.plugin.kernelApi.updateCitedBlock(witem.blockId, witem.content);
    });
    return Promise.all(update);
  }

  public async checkRefDirExist() {
    const notebookId = this.plugin.data[STORAGE_NAME].referenceNotebook as string;
    const refPath = this.plugin.data[STORAGE_NAME].referencePath as string;
    const res = await this.plugin.kernelApi.searchFileInSpecificPath(notebookId, refPath);
    this.plugin.isRefPathExist = (res.data as any[]).length ? true: false;
  }

  public async getLiteratureEnum(fileId: string): Promise<string[]> {
    // 获得该文件的全部kramdown内容，用于引用排序
    const res = await this.plugin.kernelApi.getBlockContent(fileId);
    const data = res.data as any;
    const fileContent = data.kramdown as string;
    // 获取所有可以引用的citekey，用于筛选在文件中的引用
    const citekeys = this.plugin.database.getTotalCitekeys();
    return citekeys.map(key => {
      return {
        citekey: key as string,
        idx: fileContent.indexOf(this.plugin.ck2idDict[key]) as number,
      };
    })
    .filter(key => key.idx != -1)
    .sort((a,b) => a.idx - b.idx)
    .map(item => {
      return this.plugin.ck2idDict[item.citekey];
    });

  }

  public async generateCiteLink(citekey: string, index: number) {
    const linkTemplate = this.plugin.data[STORAGE_NAME].linkTemplate as string;
    const entry = await this.plugin.database.getContentByCitekey(citekey);
    if (!entry) {
      if (isDev) this.logger.error("找不到文献数据");
      this.plugin.noticer.error(this.plugin.i18n.errors.getLiteratureFailed);
      return null;
    }
    return generateFromTemplate(linkTemplate, {
      index,
      citeFileID: this.plugin.ck2idDict[citekey],
      ...entry
    });
  }

  public async generateOnlyCiteLink(citekey: string, index: number) {
    const linkTemplate = this.plugin.data[STORAGE_NAME].linkTemplate as string;
    const linkReg = refRegInTemplate;
    const matchRes = linkTemplate.matchAll(linkReg);
    let modifiedTemplate = "";
    for (const match of matchRes) {
      if (match[1].indexOf("{{citeFileID}}") != -1) {
        modifiedTemplate = match[2];
      }
    }
    if (isDev) this.logger.info("仅包含链接的模板 =>", modifiedTemplate);
    const entry = await this.plugin.database.getContentByCitekey(citekey);
    if (!entry) {
      if (isDev) this.logger.error("找不到文献数据");
      this.plugin.noticer.error(this.plugin.i18n.errors.getLiteratureFailed);
      return null;
    }
    return generateFromTemplate(modifiedTemplate, {
      index,
      citeFileID: this.plugin.ck2idDict[citekey],
      ...entry
    });
  }

  public generateCiteRef(citeFileId: string, link: string) {
    if (this.plugin.data[STORAGE_NAME].customCiteText) {
      return link;
    } else {
      return citeLink.replace("${id}", citeFileId).replace("${link}", link);
    }
  }

  public async refreshLiteratureNoteTitles() {
    const notebookId = this.plugin.data[STORAGE_NAME].referenceNotebook as string;
    const titleTemplate = this.plugin.data[STORAGE_NAME].titleTemplate as string;
    Object.keys(this.plugin.ck2idDict).forEach(async citekey => {
      const entry = await this.plugin.database.getContentByCitekey(citekey);
      if (isDev) this.logger.info("从database中获得文献内容 =>", entry);
      if (!entry) {
        if (isDev) this.logger.error("找不到文献数据");
        this.plugin.noticer.error(this.plugin.i18n.errors.getLiteratureFailed);
        return null;
      }
      const noteTitle = generateFromTemplate(titleTemplate, entry);
      noteTitle.replace(DISALLOWED_FILENAME_CHARACTERS_RE, "_");
      // 不对的时候才更新
      const res = await this.plugin.kernelApi.getBlock(this.plugin.ck2idDict[citekey]);
      const title = res.data[0].content;
      if (noteTitle != title) await this.plugin.kernelApi.renameDoc(notebookId, res.data[0].path , noteTitle);
    });
    if (isDev) this.logger.info("所有文件标题已更新");
    this.plugin.noticer.info(this.plugin.i18n.refreshTitleSuccess.replace("${size}", Object.keys(this.plugin.ck2idDict).length));
    return this.plugin.id2ckDict, this.plugin.ck2idDict;
  }

  public async insertContent(protyle, content: string) {
    const blockId = protyle.protyle.breadcrumb.id;
    const rootId = protyle.protyle.block.rootID;
    if (isDev) this.logger.info("Protyle块ID =>", blockId);
    if (isDev) this.logger.info("Protyle文档ID =>", rootId);
    await protyle.insert(content, false, true);
    // TODO 等待前后端联动API更新再更新文档标号
    // if (isDev) this.getCursorOffsetInBlock(blockId);
    // await this.plugin.kernelApi.setBlockCited(blockId, true);
    // await this.plugin.reference.updateLiteratureLink(rootId);
  }

  public async copyContent(content: string) {
    navigator.clipboard.writeText(content);
    this.plugin.noticer.info(this.plugin.i18n.copyCiteLinkSuccess);
  }

  // private getCursorOffsetInBlock(blockId: string) {
  //   const selection = window.getSelection();
  //   const range = selection.getRangeAt(0);
  //   const refText = range.commonAncestorContainer.textContent;
  //   const refRange = document.createRange();
  //   refRange.selectNode(range.commonAncestorContainer);
  //   const block = document.querySelector(`div[data-node-id="${blockId}"]`);
  //   let offset = 0;
  //   const refReg = new RegExp(refText, "g")
  //   const matchRes = block.textContent.matchAll(refReg)
  //   console.log(block)
  //   for (const match of matchRes) {
  //     console.log(match);
  //     console.log(refRange.isPointInRange(block.firstChild, 200))
  //   }
  // }

  /**
   * Translate the human readable path to siyuan path
   * @param notebookId id of the target notebook
   * @param currentDir the current searching directory
   * @param pathSteps the rest of path that needs searching
   * @returns transelate results {success: boolean, path: string}
   */
  private async translateReferenceDir(notebookId: string, currentDir: string, pathSteps: string[]): Promise<any> {
    // 终止条件
    if (pathSteps.length == 0) {
      return {
          success: true,
          path: currentDir
        };
    }
    const res = await this.plugin.kernelApi.readDir(`/data/${notebookId}/${currentDir}`);
    const data = res.data as any[];
    // 只检索思源文本文件
    const files = data.filter((file) => {
      const p = file.name.split(".");
      const pLen = p.length;
      return !file.isDir && (p[pLen-1] == "sy");
    });
    const promise = files.map(file => {
      return this.plugin.kernelApi.getFile(`/data/${notebookId}/${currentDir}/${file.name}`, "text");
    });
    return Promise.all(promise).then(contents => {
      const subpromise = contents.map(async contentStr => {
        const content = JSON.parse(contentStr);
        if (content.Properties.title == pathSteps[0]) {
          return this.translateReferenceDir(notebookId, currentDir + `/${content.ID}`, pathSteps.slice(1)).then(res => {
            console.log(res);
            if (res.success) {
              return {
                success: true,
                path: res.path
              };
            } else {
              return res;
            }
          });
        } else {
          return {
            success: false,
            path: ""
          };
        }
      });
      return Promise.all(subpromise).then(res => {
        let success = false;
        let path = "";
        res.forEach(item => {
          if (item.success) {
            success = true;
            path = item.path;
          }
        });
        return {
          success,
          path
        };
      });
    });
  }
}